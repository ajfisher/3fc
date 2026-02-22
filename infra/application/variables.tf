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

variable "project_name" {
  description = "Project name used in resource naming"
  type        = string
  default     = "3fc"
}

variable "create_baseline_resources" {
  description = "When true, create baseline application resources."
  type        = bool
  default     = true
}

variable "site_domain" {
  description = "Primary site domain for callback/logout URL defaults"
  type        = string
  default     = "3fc.football"
}

variable "site_bucket_suffix" {
  description = "Suffix used when deriving the static site bucket name"
  type        = string
  default     = "site"
}

variable "logs_bucket_suffix" {
  description = "Suffix used when deriving the log bucket name"
  type        = string
  default     = "logs"
}

variable "dynamodb_table_suffix" {
  description = "Suffix used when deriving the DynamoDB table name"
  type        = string
  default     = "app"
}

variable "site_bucket_name" {
  description = "Optional explicit site bucket name override"
  type        = string
  default     = null
}

variable "logs_bucket_name" {
  description = "Optional explicit logs bucket name override"
  type        = string
  default     = null
}

variable "ses_from_email" {
  description = "SES sender email identity used by the app"
  type        = string
  default     = "noreply@3fc.football"
}

variable "tags" {
  description = "Additional resource tags"
  type        = map(string)
  default     = {}
}
