data "aws_partition" "current" {}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pull images, fetch Secrets, write CloudWatch Logs.
resource "aws_iam_role" "exec" {
  name               = "${var.name}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "exec_managed" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "exec_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat([
      var.control_s3_secret_arn,
      var.runtime_r2_secret_arn,
      var.secret_envelope_secret_arn,
      aws_secretsmanager_secret.admin_token.arn,
      aws_secretsmanager_secret.internal_auth_token.arn,
    ], var.internal_auth_previous_token_secret_arn == "" ? [] : [var.internal_auth_previous_token_secret_arn])
  }
}

resource "aws_iam_role_policy" "exec_secrets" {
  role   = aws_iam_role.exec.id
  policy = data.aws_iam_policy_document.exec_secrets.json
}

data "aws_iam_policy_document" "execute_command" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

# Task roles: gateway needs nothing beyond network; runtime reads bundle
# metadata from Redis (no AWS API). Separate roles so future S3 reads from
# runtime can be granted narrowly.
resource "aws_iam_role" "gateway_task" {
  name               = "${var.name}-gateway-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "runtime_task" {
  name               = "${var.name}-runtime-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "scheduler_task" {
  name               = "${var.name}-scheduler-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "workflows_task" {
  name               = "${var.name}-workflows-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "gateway_execute_command" {
  role   = aws_iam_role.gateway_task.id
  policy = data.aws_iam_policy_document.execute_command.json
}

resource "aws_iam_role_policy" "runtime_execute_command" {
  role   = aws_iam_role.runtime_task.id
  policy = data.aws_iam_policy_document.execute_command.json
}

resource "aws_iam_role_policy" "scheduler_execute_command" {
  role   = aws_iam_role.scheduler_task.id
  policy = data.aws_iam_policy_document.execute_command.json
}

resource "aws_iam_role_policy" "workflows_execute_command" {
  role   = aws_iam_role.workflows_task.id
  policy = data.aws_iam_policy_document.execute_command.json
}
