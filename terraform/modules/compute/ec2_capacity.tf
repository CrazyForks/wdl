data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended"
}

locals {
  ecs_ami_id = jsondecode(data.aws_ssm_parameter.ecs_ami.value).image_id
}

resource "aws_ecs_account_setting_default" "awsvpc_trunking" {
  name  = "awsvpcTrunking"
  value = "enabled"
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_instance" {
  name               = "${var.name}-ecs-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_instance_agent" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role_policy_attachment" "ecs_instance_ssm" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ecs_instance" {
  name = "${var.name}-ecs-instance"
  role = aws_iam_role.ecs_instance.name
}

resource "aws_security_group" "ecs_host" {
  name        = "${var.name}-ecs-host"
  description = "ECS EC2 container instance host. awsvpc tasks use their own ENIs."
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_launch_template" "ecs_host" {
  name_prefix   = "${var.name}-ecs-host-"
  image_id      = local.ecs_ami_id
  instance_type = "m8g.large"

  iam_instance_profile {
    arn = aws_iam_instance_profile.ecs_instance.arn
  }

  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [aws_security_group.ecs_host.id]
    delete_on_termination       = true
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }

  user_data = base64encode(<<-EOT
    #!/bin/bash
    cat <<EOF >> /etc/ecs/ecs.config
    ECS_CLUSTER=${aws_ecs_cluster.this.name}
    ECS_AVAILABLE_LOGGING_DRIVERS=["json-file","awslogs","awsfirelens"]
    ECS_RESERVED_MEMORY=256
    ECS_AWSVPC_BLOCK_IMDS=true
    EOF
  EOT
  )

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "ecs_host" {
  name                      = "${var.name}-ecs-host"
  vpc_zone_identifier       = var.private_subnet_ids
  min_size                  = 3
  max_size                  = 3
  desired_capacity          = 3
  health_check_grace_period = 60

  launch_template {
    id      = aws_launch_template.ecs_host.id
    version = aws_launch_template.ecs_host.latest_version
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
      instance_warmup        = 120
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.name}-ecs-host"
    propagate_at_launch = true
  }
}

resource "aws_ecs_capacity_provider" "ec2" {
  name = "${var.name}-ec2"

  auto_scaling_group_provider {
    auto_scaling_group_arn = aws_autoscaling_group.ecs_host.arn
    managed_draining       = "ENABLED"
  }
}
