output "terraform_state_bucket" {
  value       = aws_s3_bucket.terraform_state.id
  description = "S3 bucket for Terraform remote state."
}

output "cloudtrail_bucket" {
  value       = aws_s3_bucket.cloudtrail.id
  description = "S3 bucket receiving CloudTrail management event logs."
}

output "cloudtrail_arn" {
  value       = aws_cloudtrail.management.arn
  description = "Multi-region CloudTrail ARN."
}

output "s3_backend_example" {
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.terraform_state.id}"
    region       = "${local.region}"
    encrypt      = true
    use_lockfile = true
  EOT
  description = "Base backend.hcl snippet. Add a unique key per stack, such as key = \"foundation/terraform.tfstate\"."
}
