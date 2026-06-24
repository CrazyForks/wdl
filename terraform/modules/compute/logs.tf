resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/ecs/${var.name}/gateway"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/ecs/${var.name}/runtime"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "d1_runtime" {
  name              = "/ecs/${var.name}/d1-runtime"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "do_runtime" {
  name              = "/ecs/${var.name}/do-runtime"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "scheduler" {
  name              = "/ecs/${var.name}/scheduler"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "workflows" {
  name              = "/ecs/${var.name}/workflows"
  retention_in_days = var.log_retention_days
}
