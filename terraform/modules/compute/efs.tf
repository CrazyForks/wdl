resource "aws_security_group" "d1_storage" {
  name        = "${var.name}-d1-storage"
  description = "EFS for d1-runtime localDisk storage"
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "d1_storage_from_runtime" {
  type                     = "ingress"
  from_port                = 2049
  to_port                  = 2049
  protocol                 = "tcp"
  security_group_id        = aws_security_group.d1_storage.id
  source_security_group_id = aws_security_group.runtime.id
}

resource "aws_efs_file_system" "d1_storage" {
  creation_token   = "${var.name}-d1-storage"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_efs_mount_target" "d1_storage" {
  for_each = toset(var.private_subnet_ids)

  file_system_id  = aws_efs_file_system.d1_storage.id
  subnet_id       = each.value
  security_groups = [aws_security_group.d1_storage.id]
}

resource "aws_security_group" "do_storage" {
  name        = "${var.name}-do-storage"
  description = "EFS for do-runtime localDisk storage"
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "do_storage_from_runtime" {
  type                     = "ingress"
  from_port                = 2049
  to_port                  = 2049
  protocol                 = "tcp"
  security_group_id        = aws_security_group.do_storage.id
  source_security_group_id = aws_security_group.runtime.id
}

resource "aws_efs_file_system" "do_storage" {
  creation_token   = "${var.name}-do-storage"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_efs_mount_target" "do_storage" {
  for_each = toset(var.private_subnet_ids)

  file_system_id  = aws_efs_file_system.do_storage.id
  subnet_id       = each.value
  security_groups = [aws_security_group.do_storage.id]
}
