provider "aws" {
  region = var.region
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

  app_tags = merge(
    {
      Project     = var.project_name
      Environment = var.env
      ManagedBy   = "terraform"
    },
    var.tags,
  )
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
    cloudfront_default_certificate = true
  }

  tags = local.app_tags
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

resource "aws_cognito_user_pool_client" "web" {
  count = var.create_baseline_resources ? 1 : 0

  name         = "${local.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.app[0].id

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = ["https://${var.site_domain}/auth/callback"]
  logout_urls   = ["https://${var.site_domain}"]

  generate_secret = false
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

output "api_invoke_url" {
  description = "Base invoke URL for the HTTP API"
  value       = try(aws_apigatewayv2_stage.default[0].invoke_url, null)
}

output "api_execution_arn" {
  description = "Execution ARN for the HTTP API"
  value       = try(aws_apigatewayv2_api.http[0].execution_arn, null)
}

output "lambda_execution_role_arn" {
  description = "Execution role ARN used by deployed Lambda functions"
  value       = try(aws_iam_role.lambda_exec[0].arn, null)
}

output "github_actions_deploy_role_arn" {
  description = "OIDC-assumable IAM role ARN for GitHub Actions deployments"
  value       = try(aws_iam_role.github_actions_deploy[0].arn, null)
}
