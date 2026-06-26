output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = [for subnet in aws_subnet.public : subnet.id]
}

output "private_subnet_ids" {
  value = [for subnet in aws_subnet.private : subnet.id]
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

output "alb_https_listener_arn" {
  value       = var.validate_certificates ? aws_lb_listener.https[0].arn : null
  description = "HTTPS listener ARN for the app stack. Null until validate_certificates is true and ACM validation succeeds."
}

output "manual_dns_records" {
  value = {
    admin_host = {
      name  = var.admin_host
      type  = "CNAME"
      value = aws_lb.this.dns_name
    }
    platform_domain = {
      name  = var.platform_domain
      type  = "CNAME"
      value = aws_lb.this.dns_name
    }
    site_host = local.site_host_enabled ? {
      name   = var.site_host
      target = aws_lb.this.dns_name
    } : null
    site_www_host = local.site_host_enabled ? {
      name   = local.site_www_host
      target = aws_lb.this.dns_name
    } : null
    additional_public_hosts = {
      for host in var.additional_public_hosts : host => {
        name   = host
        target = aws_lb.this.dns_name
      }
    }
  }
  description = "External DNS targets to create after the ALB exists. For apex site hosts such as wdl.dev, use the DNS provider's supported flattened/proxied target form."
}

output "alb_certificate_validation_records" {
  value = {
    for record in aws_acm_certificate.alb.domain_validation_options : record.domain_name => {
      name  = record.resource_record_name
      type  = record.resource_record_type
      value = record.resource_record_value
    }
  }
}

output "assets_cdn_acm_certificate_arn" {
  value       = local.assets_cdn_enabled ? aws_acm_certificate.assets_cdn[0].arn : ""
  description = "us-east-1 ACM certificate ARN for CloudFront assets CDN. Empty when assets_cdn_domain is unset."
}

output "assets_cdn_certificate_validation_records" {
  value = local.assets_cdn_enabled ? {
    for record in aws_acm_certificate.assets_cdn[0].domain_validation_options : record.domain_name => {
      name  = record.resource_record_name
      type  = record.resource_record_type
      value = record.resource_record_value
    }
  } : {}
}

output "site_certificate_validation_records" {
  value = local.public_alb_hosts_enabled ? {
    for record in aws_acm_certificate.site[0].domain_validation_options : record.domain_name => {
      name  = record.resource_record_name
      type  = record.resource_record_type
      value = record.resource_record_value
    }
  } : {}
}
