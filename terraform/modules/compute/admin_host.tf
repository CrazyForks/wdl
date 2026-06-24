# Admin host routes to the same gateway TG as the platform wildcard;
# gateway's env.ADMIN_HOST short-circuits to env.CONTROL (system-runtime:8082).
#
# Header is enforced at both layers: ALB requires the X-Admin-Token header
# to be present, while control/auth performs the real token verification.
# That keeps a cheap edge-level shape check without hard-coding a single
# bootstrap token in the ALB rule.

# Authorized path — host + any non-omitted X-Admin-Token header → forward.
resource "aws_lb_listener_rule" "admin_host" {
  listener_arn = var.alb_https_listener_arn
  priority     = 4550

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }

  condition {
    host_header {
      values = [var.admin_host]
    }
  }

  condition {
    http_header {
      http_header_name = "X-Admin-Token"
      values           = ["*"]
    }
  }
}

# Fallback: same host, missing header → 401 at the edge. Higher priority
# number runs after the authorized rule above, so requests that include the
# header still forward and are verified in control/auth.
resource "aws_lb_listener_rule" "admin_host_unauthorized" {
  listener_arn = var.alb_https_listener_arn
  priority     = 4551

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      status_code  = "401"
      message_body = "{\"error\":\"unauthorized\"}"
    }
  }

  condition {
    host_header {
      values = [var.admin_host]
    }
  }
}

# Reaches containers only through Secrets Manager injection into
# system-runtime's task def.
resource "random_password" "admin_token" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "admin_token" {
  name                    = "${var.name}/admin-token"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "admin_token" {
  secret_id     = aws_secretsmanager_secret.admin_token.id
  secret_string = random_password.admin_token.result
}
