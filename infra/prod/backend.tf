terraform {
  backend "s3" {
    bucket         = "ajf-3fc-terraform-state"
    key            = "3fc/prod/terraform.tfstate"
    region         = "ap-southeast-2"
    dynamodb_table = "ajf-3fc-terraform-locks"
    encrypt        = true
  }
}
