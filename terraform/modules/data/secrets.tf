# aws4fetch signs with static keys (no provider chain), so control
# gets a dedicated IAM user scoped to PutObject. Key lands in ECS via
# Secrets Manager JSON.
resource "aws_iam_user" "control_s3" {
  name = "${var.name}-control-s3"
}

data "aws_iam_policy_document" "control_s3" {
  statement {
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.assets.arn}/*"]
  }
}

resource "aws_iam_user_policy" "control_s3" {
  user   = aws_iam_user.control_s3.name
  policy = data.aws_iam_policy_document.control_s3.json
}

resource "aws_iam_access_key" "control_s3" {
  user = aws_iam_user.control_s3.name
}

resource "aws_secretsmanager_secret" "control_s3" {
  name                    = "${var.name}/control-s3"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "control_s3" {
  secret_id = aws_secretsmanager_secret.control_s3.id
  secret_string = jsonencode({
    access_key_id     = aws_iam_access_key.control_s3.id
    secret_access_key = aws_iam_access_key.control_s3.secret
  })
}

# Async worker-delete GC needs List + Delete; deliberately separate
# from control's PutObject-only IAM so a control-side compromise
# cannot delete tenant assets. Key is surfaced via Secrets Manager;
# operator injects into Redis — never wire into ECS task env.
resource "aws_iam_user" "s3_cleanup" {
  name = "${var.name}-s3-cleanup"
}

data "aws_iam_policy_document" "s3_cleanup" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.assets.arn]
  }
  statement {
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.assets.arn}/*"]
  }
}

resource "aws_iam_user_policy" "s3_cleanup" {
  user   = aws_iam_user.s3_cleanup.name
  policy = data.aws_iam_policy_document.s3_cleanup.json
}

resource "aws_iam_access_key" "s3_cleanup" {
  user = aws_iam_user.s3_cleanup.name
}

resource "aws_secretsmanager_secret" "s3_cleanup" {
  name                    = "${var.name}/s3-cleanup"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "s3_cleanup" {
  secret_id = aws_secretsmanager_secret.s3_cleanup.id
  secret_string = jsonencode({
    access_key_id     = aws_iam_access_key.s3_cleanup.id
    secret_access_key = aws_iam_access_key.s3_cleanup.secret
  })
}

# Runtime R2 binding credentials. This user is scoped to the R2 physical
# bucket only; tenant isolation is enforced by the runtime's r2/<ns>/<bucket>/
# prefix mapping before any S3 request is signed.
resource "aws_iam_user" "runtime_r2" {
  name = "${var.name}-runtime-r2"
}

data "aws_iam_policy_document" "runtime_r2" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.r2.arn]
  }
  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.r2.arn}/*"]
  }
}

resource "aws_iam_user_policy" "runtime_r2" {
  user   = aws_iam_user.runtime_r2.name
  policy = data.aws_iam_policy_document.runtime_r2.json
}

resource "aws_iam_access_key" "runtime_r2" {
  user = aws_iam_user.runtime_r2.name
}

resource "aws_secretsmanager_secret" "runtime_r2" {
  name                    = "${var.name}/runtime-r2"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "runtime_r2" {
  secret_id = aws_secretsmanager_secret.runtime_r2.id
  secret_string = jsonencode({
    access_key_id     = aws_iam_access_key.runtime_r2.id
    secret_access_key = aws_iam_access_key.runtime_r2.secret
  })
}

# Current local-provider root key for WDL secret envelope encryption. The value
# is held in Secrets Manager and injected as ECS secrets; a future KMS provider
# can replace this implementation under the same envelope contract.
resource "random_id" "secret_envelope_local_key" {
  byte_length = 32

  lifecycle {
    prevent_destroy = true
  }
}

# Do not taint or recreate this local-provider key as a normal rotation action:
# existing envelopes would keep the same kid but become undecryptable. Automated
# key rotation/rewrap is not implemented in Terraform; introduce a new key
# version only with a separately implemented and verified rewrap procedure.
resource "aws_secretsmanager_secret" "secret_envelope" {
  name                    = "${var.name}/secret-envelope"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "secret_envelope" {
  secret_id = aws_secretsmanager_secret.secret_envelope.id
  secret_string = jsonencode({
    local_key_b64 = random_id.secret_envelope_local_key.b64_std
    kid           = "local:${var.name}:secret-envelope:v1"
  })
}
