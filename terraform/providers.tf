provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "wdl"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
