# CloudFront distribution in front of the assets bucket. Gated on
# assets_cdn_acm_certificate_arn so the rest of the stack can apply before
# DNS/certificate setup is ready.

locals {
  assets_origin_id    = "assets-s3"
  assets_read_methods = ["GET", "HEAD"]
  cdn_enabled         = var.assets_cdn_domain != "" && var.assets_cdn_acm_certificate_arn != ""
  cdn_count           = local.cdn_enabled ? 1 : 0
}

resource "aws_cloudfront_origin_access_control" "assets" {
  count                             = local.cdn_count
  name                              = "${var.name}-assets-oac"
  description                       = "${var.name} assets S3 origin access"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "assets_cdn" {
  count = local.cdn_count

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.assets[0].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "assets_cdn" {
  count  = local.cdn_count
  bucket = aws_s3_bucket.assets.id
  policy = data.aws_iam_policy_document.assets_cdn[0].json
}

resource "aws_cloudfront_response_headers_policy" "assets_cors" {
  count = local.cdn_count
  name  = "${var.name}-assets-cors"

  cors_config {
    access_control_allow_credentials = false

    access_control_allow_headers {
      items = ["*"]
    }

    access_control_allow_methods {
      items = local.assets_read_methods
    }

    access_control_allow_origins {
      items = ["*"]
    }

    access_control_expose_headers {
      items = ["ETag"]
    }

    access_control_max_age_sec = 86400
    origin_override            = true
  }
}

resource "aws_cloudfront_cache_policy" "assets" {
  count       = local.cdn_count
  name        = "${var.name}-assets-cache"
  comment     = "${var.name} assets cache policy"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_distribution" "assets" {
  count           = local.cdn_count
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} assets CDN"
  aliases         = [var.assets_cdn_domain]
  price_class     = "PriceClass_All"

  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = local.assets_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.assets[0].id
  }

  default_cache_behavior {
    target_origin_id           = local.assets_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = local.assets_read_methods
    cached_methods             = local.assets_read_methods
    cache_policy_id            = aws_cloudfront_cache_policy.assets[0].id
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.assets_cors[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.assets_cdn_acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
