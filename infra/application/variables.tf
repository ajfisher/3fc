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

variable "api_domain" {
  description = "Optional API custom domain (for example api.3fc.football)"
  type        = string
  default     = null
  nullable    = true
}

variable "cognito_domain" {
  description = "Optional Cognito Hosted UI custom domain (for example auth.3fc.football)"
  type        = string
  default     = null
  nullable    = true
}

variable "google_oauth_client_id" {
  description = "Google OAuth web client ID used by Cognito social sign-in"
  type        = string
  default     = null
  nullable    = true
}

variable "google_oauth_client_secret" {
  description = "Google OAuth web client secret used by Cognito social sign-in"
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "hosted_zone_name" {
  description = "Route53 public hosted zone name used for DNS validation and alias records"
  type        = string
  default     = "3fc.football"
}

variable "enable_custom_domains" {
  description = "When true, provision ACM + Route53 + API/CloudFront custom domain wiring"
  type        = bool
  default     = true
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

variable "github_repository" {
  description = "GitHub repository allowed to assume deploy role (owner/repo)"
  type        = string
  default     = "ajfisher/3fc"
}

variable "github_environment_name" {
  description = "GitHub Actions environment name allowed to assume deploy role"
  type        = string
}

variable "create_github_oidc_provider" {
  description = "When true, create the GitHub OIDC provider in this environment stack"
  type        = bool
  default     = false
}

variable "github_oidc_client_id_list" {
  description = "OIDC client IDs for the GitHub provider"
  type        = list(string)
  default     = ["sts.amazonaws.com"]
}

variable "github_oidc_thumbprint_list" {
  description = "Thumbprints used when creating the GitHub OIDC provider"
  type        = list(string)
  default     = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

variable "tags" {
  description = "Additional resource tags"
  type        = map(string)
  default     = {}
}
