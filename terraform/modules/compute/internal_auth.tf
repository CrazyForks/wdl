resource "random_password" "internal_auth_token" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "internal_auth_token" {
  name                    = "${var.name}/internal-auth-token"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "internal_auth_token" {
  secret_id     = aws_secretsmanager_secret.internal_auth_token.id
  secret_string = random_password.internal_auth_token.result
}
