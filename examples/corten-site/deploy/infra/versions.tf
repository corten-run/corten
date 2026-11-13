terraform {
  required_version = ">= 1.10"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.107"
    }
  }

  # The state is one object in a Spaces bucket. Spaces speaks S3's protocol, so the bucket's
  # name, its endpoint (AWS_ENDPOINT_URL_S3) and its keys are given when `tofu init` runs
  # (../README.md); the region here is only a name S3's protocol asks for. Nothing locks the
  # state: the workflow that applies it runs one job at a time.
  backend "s3" {
    key                         = "corten-site.tfstate"
    region                      = "us-east-1"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}

# The token is read from DIGITALOCEAN_TOKEN.
provider "digitalocean" {}
