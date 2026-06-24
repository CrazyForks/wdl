variable "region" {
  type        = string
  default     = "ap-east-1"
  description = "AWS region for VPC, ALB, and the regional ACM certificate."
}

variable "environment" {
  type        = string
  default     = "test"
  description = "Value for the AWS default Environment tag."
  validation {
    condition     = contains(["test", "staging", "prod"], var.environment)
    error_message = "environment must be one of: test, staging, prod."
  }
}

variable "name_prefix" {
  type        = string
  description = "Resource name prefix, e.g. wdl-demo."
}

variable "vpc_cidr" {
  type        = string
  default     = "10.64.0.0/16"
  description = "CIDR block for the WDL VPC."
}

variable "public_subnet_cidrs" {
  type        = list(string)
  default     = ["10.64.0.0/20", "10.64.16.0/20", "10.64.32.0/20"]
  description = "Exactly three public subnet CIDR blocks."
  validation {
    condition     = length(var.public_subnet_cidrs) == 3
    error_message = "public_subnet_cidrs must contain exactly three CIDR blocks."
  }
}

variable "private_subnet_cidrs" {
  type        = list(string)
  default     = ["10.64.128.0/20", "10.64.144.0/20", "10.64.160.0/20"]
  description = "Exactly three private subnet CIDR blocks."
  validation {
    condition     = length(var.private_subnet_cidrs) == 3
    error_message = "private_subnet_cidrs must contain exactly three CIDR blocks."
  }
}

variable "admin_host" {
  type        = string
  description = "Exact control-plane host, e.g. api.wdl.dev."
  validation {
    condition = (
      length(var.admin_host) > 0 &&
      var.admin_host == trimspace(var.admin_host) &&
      !startswith(var.admin_host, "*.") &&
      !strcontains(var.admin_host, "://") &&
      !strcontains(var.admin_host, "/") &&
      !strcontains(var.admin_host, ":")
    )
    error_message = "admin_host must be an exact host such as api.wdl.dev, without wildcard, scheme, path, port, or surrounding whitespace."
  }
}

variable "platform_domain" {
  type        = string
  description = "Wildcard tenant host, e.g. *.wdl.sh."
  validation {
    condition = (
      startswith(var.platform_domain, "*.") &&
      !strcontains(var.platform_domain, "://") &&
      !strcontains(var.platform_domain, "/") &&
      !strcontains(var.platform_domain, ":") &&
      var.platform_domain == trimspace(var.platform_domain)
    )
    error_message = "platform_domain must be a wildcard host such as *.wdl.sh, without scheme, path, port, or surrounding whitespace."
  }
}

variable "site_host" {
  type        = string
  default     = ""
  description = "Optional exact canonical public site host that should terminate TLS on the ALB and forward to the WDL gateway, e.g. wdl.dev. The www host is derived automatically."
  validation {
    condition = (
      var.site_host == "" || (
        var.site_host == trimspace(var.site_host) &&
        !startswith(var.site_host, "www.") &&
        !startswith(var.site_host, "*.") &&
        !strcontains(var.site_host, "://") &&
        !strcontains(var.site_host, "/") &&
        !strcontains(var.site_host, ":")
      )
    )
    error_message = "site_host must be empty or an exact canonical host such as wdl.dev, without www prefix, wildcard, scheme, path, port, or surrounding whitespace."
  }
}

variable "assets_cdn_domain" {
  type        = string
  default     = ""
  description = "Optional assets CDN alias, e.g. assets.wdl.dev. When set, foundation creates a us-east-1 ACM certificate and outputs its DNS validation record."
}

variable "validate_certificates" {
  type        = bool
  default     = false
  description = "Set true after external DNS validation records exist. This waits for ACM validation and creates the ALB HTTPS listener."
}
