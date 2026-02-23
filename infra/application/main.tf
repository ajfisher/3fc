provider "aws" {
  region = var.region
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  name_prefix = "${var.project_name}-${var.env}"

  site_bucket_name = var.site_bucket_name != null ? var.site_bucket_name : "${local.name_prefix}-${var.site_bucket_suffix}"
  logs_bucket_name = var.logs_bucket_name != null ? var.logs_bucket_name : "${local.name_prefix}-${var.logs_bucket_suffix}"

  github_oidc_provider_url              = "https://token.actions.githubusercontent.com"
  github_oidc_provider_host             = trimprefix(local.github_oidc_provider_url, "https://")
  github_oidc_provider_arn_from_account = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/${local.github_oidc_provider_host}"
  github_oidc_provider_arn              = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github_actions[0].arn : local.github_oidc_provider_arn_from_account
  github_oidc_subject                   = "repo:${var.github_repository}:environment:${var.github_environment_name}"
  hosted_zone_name                      = endswith(var.hosted_zone_name, ".") ? var.hosted_zone_name : "${var.hosted_zone_name}."
  site_custom_domain_enabled            = var.create_baseline_resources && var.enable_custom_domains
  api_custom_domain_enabled             = var.create_baseline_resources && var.enable_custom_domains && var.api_domain != null
  cognito_custom_domain_enabled         = var.create_baseline_resources && var.enable_custom_domains && var.cognito_domain != null
  google_oauth_client_id                = var.google_oauth_client_id != null && trimspace(var.google_oauth_client_id) != "" ? trimspace(var.google_oauth_client_id) : null
  google_oauth_client_secret            = var.google_oauth_client_secret != null && trimspace(var.google_oauth_client_secret) != "" ? trimspace(var.google_oauth_client_secret) : null
  google_identity_provider_enabled      = local.google_oauth_client_id != null

  app_tags = merge(
    {
      Project     = var.project_name
      Environment = var.env
      ManagedBy   = "terraform"
    },
    var.tags,
  )
}

data "aws_route53_zone" "primary" {
  count = local.site_custom_domain_enabled || local.api_custom_domain_enabled || local.cognito_custom_domain_enabled ? 1 : 0

  name         = local.hosted_zone_name
  private_zone = false
}

resource "aws_s3_bucket" "site" {
  count = var.create_baseline_resources ? 1 : 0

  bucket = local.site_bucket_name
  tags   = local.app_tags
}

resource "aws_s3_bucket_public_access_block" "site" {
  count = var.create_baseline_resources ? 1 : 0

  bucket = aws_s3_bucket.site[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "logs" {
  count = var.create_baseline_resources ? 1 : 0

  bucket = local.logs_bucket_name
  tags   = local.app_tags
}

resource "aws_cloudfront_origin_access_control" "site" {
  count = var.create_baseline_resources ? 1 : 0

  name                              = "${local.name_prefix}-site-oac"
  description                       = "OAC for ${local.name_prefix} static site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  count = var.create_baseline_resources ? 1 : 0

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.name_prefix} site"
  default_root_object = "index.html"
  aliases             = local.site_custom_domain_enabled ? [var.site_domain] : []

  origin {
    domain_name              = aws_s3_bucket.site[0].bucket_regional_domain_name
    origin_id                = "${local.name_prefix}-site-origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.site[0].id
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "${local.name_prefix}-site-origin"

    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn            = local.site_custom_domain_enabled ? aws_acm_certificate_validation.site[0].certificate_arn : null
    cloudfront_default_certificate = local.site_custom_domain_enabled ? false : true
    minimum_protocol_version       = local.site_custom_domain_enabled ? "TLSv1.2_2021" : null
    ssl_support_method             = local.site_custom_domain_enabled ? "sni-only" : null
  }

  tags = local.app_tags
}

resource "aws_acm_certificate" "site" {
  count    = local.site_custom_domain_enabled ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.site_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.app_tags
}

resource "aws_route53_record" "site_certificate_validation" {
  for_each = local.site_custom_domain_enabled ? {
    for option in aws_acm_certificate.site[0].domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "site" {
  count    = local.site_custom_domain_enabled ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [for record in aws_route53_record.site_certificate_validation : record.fqdn]
}

resource "aws_route53_record" "site_alias_ipv4" {
  count = local.site_custom_domain_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = var.site_domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site[0].domain_name
    zone_id                = aws_cloudfront_distribution.site[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_alias_ipv6" {
  count = local.site_custom_domain_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = var.site_domain
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site[0].domain_name
    zone_id                = aws_cloudfront_distribution.site[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_dynamodb_table" "app" {
  count = var.create_baseline_resources ? 1 : 0

  # Baseline datastore scaffold for the single-table model introduced in M1.
  name         = "${local.name_prefix}-${var.dynamodb_table_suffix}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = local.app_tags
}

resource "aws_cognito_user_pool" "app" {
  count = var.create_baseline_resources ? 1 : 0

  name = "${local.name_prefix}-users"

  auto_verified_attributes = ["email"]

  username_attributes = ["email"]

  tags = local.app_tags
}

resource "aws_acm_certificate" "cognito_domain" {
  count    = local.cognito_custom_domain_enabled ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.cognito_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.app_tags
}

resource "aws_route53_record" "cognito_domain_certificate_validation" {
  for_each = local.cognito_custom_domain_enabled ? {
    for option in aws_acm_certificate.cognito_domain[0].domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "cognito_domain" {
  count    = local.cognito_custom_domain_enabled ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.cognito_domain[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cognito_domain_certificate_validation : record.fqdn]
}

resource "aws_cognito_user_pool_domain" "app" {
  count = local.cognito_custom_domain_enabled ? 1 : 0

  domain          = var.cognito_domain
  user_pool_id    = aws_cognito_user_pool.app[0].id
  certificate_arn = aws_acm_certificate_validation.cognito_domain[0].certificate_arn
}

resource "aws_route53_record" "cognito_domain_alias_ipv4" {
  count = local.cognito_custom_domain_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = var.cognito_domain
  type    = "A"

  alias {
    name                   = aws_cognito_user_pool_domain.app[0].cloudfront_distribution
    zone_id                = aws_cognito_user_pool_domain.app[0].cloudfront_distribution_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "cognito_domain_alias_ipv6" {
  count = local.cognito_custom_domain_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = var.cognito_domain
  type    = "AAAA"

  alias {
    name                   = aws_cognito_user_pool_domain.app[0].cloudfront_distribution
    zone_id                = aws_cognito_user_pool_domain.app[0].cloudfront_distribution_zone_id
    evaluate_target_health = false
  }
}

resource "aws_cognito_identity_provider" "google" {
  count = local.google_identity_provider_enabled ? 1 : 0

  user_pool_id  = aws_cognito_user_pool.app[0].id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    authorize_scopes = "openid email profile"
    client_id        = local.google_oauth_client_id
    client_secret    = local.google_oauth_client_secret
  }

  attribute_mapping = {
    email = "email"
  }

  lifecycle {
    precondition {
      condition     = local.google_oauth_client_secret != null
      error_message = "google_oauth_client_secret must be set when google_oauth_client_id is provided."
    }
  }
}

resource "aws_cognito_user_pool_client" "web" {
  count = var.create_baseline_resources ? 1 : 0

  name         = "${local.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.app[0].id

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = concat(["COGNITO"], local.google_identity_provider_enabled ? ["Google"] : [])

  callback_urls = ["https://${var.site_domain}/auth/callback"]
  logout_urls   = ["https://${var.site_domain}"]

  generate_secret = false

  depends_on = [aws_cognito_identity_provider.google]
}

resource "aws_apigatewayv2_api" "http" {
  count = var.create_baseline_resources ? 1 : 0

  name          = "${local.name_prefix}-http-api"
  protocol_type = "HTTP"

  tags = local.app_tags
}

resource "aws_apigatewayv2_stage" "default" {
  count = var.create_baseline_resources ? 1 : 0

  api_id      = aws_apigatewayv2_api.http[0].id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    detailed_metrics_enabled = false
    throttling_burst_limit   = 100
    throttling_rate_limit    = 50
  }

  tags = local.app_tags
}

resource "aws_acm_certificate" "api" {
  count = local.api_custom_domain_enabled ? 1 : 0

  domain_name       = var.api_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.app_tags
}

resource "aws_route53_record" "api_certificate_validation" {
  for_each = local.api_custom_domain_enabled ? {
    for option in aws_acm_certificate.api[0].domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]
}

resource "aws_acm_certificate_validation" "api" {
  count = local.api_custom_domain_enabled ? 1 : 0

  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for record in aws_route53_record.api_certificate_validation : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "http_custom" {
  count = local.api_custom_domain_enabled ? 1 : 0

  domain_name = var.api_domain

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.api[0].certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = local.app_tags
}

resource "aws_apigatewayv2_api_mapping" "http_custom_default" {
  count = local.api_custom_domain_enabled ? 1 : 0

  api_id      = aws_apigatewayv2_api.http[0].id
  domain_name = aws_apigatewayv2_domain_name.http_custom[0].id
  stage       = aws_apigatewayv2_stage.default[0].id
}

resource "aws_route53_record" "api_alias_ipv4" {
  count = local.api_custom_domain_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = var.api_domain
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.http_custom[0].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.http_custom[0].domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "api_alias_ipv6" {
  count = local.api_custom_domain_enabled ? 1 : 0

  zone_id = data.aws_route53_zone.primary[0].zone_id
  name    = var.api_domain
  type    = "AAAA"

  alias {
    name                   = aws_apigatewayv2_domain_name.http_custom[0].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.http_custom[0].domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_iam_role" "lambda_exec" {
  count = var.create_baseline_resources ? 1 : 0

  name = "${local.name_prefix}-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = local.app_tags
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  count = var.create_baseline_resources ? 1 : 0

  role       = aws_iam_role.lambda_exec[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_openid_connect_provider" "github_actions" {
  count = var.create_baseline_resources && var.create_github_oidc_provider ? 1 : 0

  url             = local.github_oidc_provider_url
  client_id_list  = var.github_oidc_client_id_list
  thumbprint_list = var.github_oidc_thumbprint_list

  lifecycle {
    prevent_destroy = true
  }
}

data "aws_iam_policy_document" "github_actions_deploy_assume" {
  count = var.create_baseline_resources ? 1 : 0

  statement {
    effect = "Allow"
    actions = [
      "sts:AssumeRoleWithWebIdentity",
    ]

    principals {
      type = "Federated"
      identifiers = [
        local.github_oidc_provider_arn,
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_oidc_subject]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  count = var.create_baseline_resources ? 1 : 0

  name               = "${local.name_prefix}-github-actions-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_actions_deploy_assume[0].json
  tags               = local.app_tags
}

data "aws_iam_policy_document" "github_actions_deploy_permissions" {
  count = var.create_baseline_resources ? 1 : 0

  statement {
    sid    = "ServerlessDeploymentControlPlane"
    effect = "Allow"
    actions = [
      "apigateway:*",
      "cloudformation:*",
      "lambda:*",
      "logs:*",
      "s3:*",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ReadLambdaExecutionRole"
    effect = "Allow"
    actions = [
      "iam:GetRole",
    ]
    resources = [aws_iam_role.lambda_exec[0].arn]
  }

  statement {
    sid    = "PassLambdaExecutionRole"
    effect = "Allow"
    actions = [
      "iam:PassRole",
    ]
    resources = [aws_iam_role.lambda_exec[0].arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  count = var.create_baseline_resources ? 1 : 0

  name   = "${local.name_prefix}-github-actions-deploy"
  role   = aws_iam_role.github_actions_deploy[0].id
  policy = data.aws_iam_policy_document.github_actions_deploy_permissions[0].json
}

resource "aws_ses_email_identity" "from_address" {
  count = var.create_baseline_resources ? 1 : 0

  email = var.ses_from_email
}

output "baseline_resources_enabled" {
  description = "Whether baseline resources are enabled for this environment"
  value       = var.create_baseline_resources
}

output "site_bucket_name" {
  description = "Name of the static site bucket"
  value       = try(aws_s3_bucket.site[0].id, null)
}

output "dynamodb_table_name" {
  description = "Name of the DynamoDB application table"
  value       = try(aws_dynamodb_table.app[0].name, null)
}

output "api_id" {
  description = "HTTP API ID"
  value       = try(aws_apigatewayv2_api.http[0].id, null)
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID"
  value       = try(aws_cognito_user_pool.app[0].id, null)
}

output "cognito_user_pool_client_id" {
  description = "Cognito user pool app client ID"
  value       = try(aws_cognito_user_pool_client.web[0].id, null)
}

output "cognito_hosted_ui_domain" {
  description = "Cognito Hosted UI domain"
  value       = try(aws_cognito_user_pool_domain.app[0].domain, null)
}

output "cognito_hosted_ui_base_url" {
  description = "Cognito Hosted UI base URL"
  value       = try("https://${aws_cognito_user_pool_domain.app[0].domain}", null)
}

output "cognito_idp_response_url" {
  description = "OAuth redirect URI to register with social IdPs"
  value       = try("https://${aws_cognito_user_pool_domain.app[0].domain}/oauth2/idpresponse", null)
}

output "api_invoke_url" {
  description = "Base invoke URL for the HTTP API"
  value       = try(aws_apigatewayv2_stage.default[0].invoke_url, null)
}

output "api_execution_arn" {
  description = "Execution ARN for the HTTP API"
  value       = try(aws_apigatewayv2_api.http[0].execution_arn, null)
}

output "site_custom_domain_url" {
  description = "HTTPS URL for the site custom domain"
  value       = local.site_custom_domain_enabled ? "https://${var.site_domain}" : null
}

output "api_custom_domain_url" {
  description = "HTTPS URL for the API custom domain"
  value       = local.api_custom_domain_enabled ? "https://${var.api_domain}" : null
}

output "lambda_execution_role_arn" {
  description = "Execution role ARN used by deployed Lambda functions"
  value       = try(aws_iam_role.lambda_exec[0].arn, null)
}

output "github_actions_deploy_role_arn" {
  description = "OIDC-assumable IAM role ARN for GitHub Actions deployments"
  value       = try(aws_iam_role.github_actions_deploy[0].arn, null)
}
