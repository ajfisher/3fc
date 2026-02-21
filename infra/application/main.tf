provider "aws" {
  region = "ap-southeast-2"
}

locals {
  name_prefix = "3fc-${var.env}"
}
