output "assets_bucket" {
  value = module.data.assets_bucket_name
}

output "r2_bucket" {
  value = module.data.r2_bucket_name
}

output "assets_cdn_base" {
  value = module.data.assets_cdn_base
}

output "assets_cdn_distribution_domain" {
  value = module.data.assets_cdn_distribution_domain
}

output "valkey_endpoint" {
  value = "${module.data.valkey_primary_endpoint}:${module.data.valkey_port}"
}

output "control_s3_secret_arn" {
  value = module.data.control_s3_secret_arn
}

output "s3_cleanup_secret_arn" {
  value       = module.data.s3_cleanup_secret_arn
  description = "Secrets Manager ARN carrying the s3-cleanup IAM user's key. Inject into Redis via `wdl secret put --ns __system__ --worker s3-cleanup …`; never wire into ECS task env."
}

output "runtime_r2_secret_arn" {
  value       = module.data.runtime_r2_secret_arn
  description = "Secrets Manager ARN carrying the scoped R2 IAM user's key. Wired into user runtime and system runtime/control as R2_S3_*."
}

output "secret_envelope_secret_arn" {
  value       = module.data.secret_envelope_secret_arn
  description = "Secrets Manager ARN carrying SECRET_ENVELOPE_LOCAL_KEY_B64 and SECRET_ENVELOPE_KID for the current local-provider envelope implementation. Injected into redis-proxy sidecars and system-runtime/control."
}

output "gateway_target_group_arn" {
  value = module.compute.gateway_target_group_arn
}

output "ecs_cluster_name" {
  value = module.compute.cluster_name
}

output "d1_runtime_service_name" {
  value = module.compute.d1_runtime_service_name
}

output "do_runtime_service_name" {
  value = module.compute.do_runtime_service_name
}

output "workflows_service_name" {
  value = module.compute.workflows_service_name
}

output "d1_storage_file_system_id" {
  value = module.compute.d1_storage_file_system_id
}

output "do_storage_file_system_id" {
  value = module.compute.do_storage_file_system_id
}

output "admin_token" {
  value       = module.compute.admin_token
  sensitive   = true
  description = "Bootstrap control-plane token. Retrieve with `terraform output -raw admin_token`; clients usually send it as X-Admin-Token via ADMIN_TOKEN for `wdl deploy` / `wdl secret`. ALB only checks header presence; server-side auth verifies the token and injects this one as BOOTSTRAP_TOKEN."
}
