variable "name" {
  type        = string
  description = "Name prefix for all resources in this module."
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "assets_cdn_domain" {
  type = string
}

variable "assets_cdn_acm_certificate_arn" {
  type = string
}
