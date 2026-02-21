variable "env" {
  description = "Environment name (e.g. qa, prod)"
  type        = string

  validation {
    condition     = contains(["qa", "prod"], var.env)
    error_message = "env must be one of: qa, prod"
  }
}

variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-southeast-2"
}
