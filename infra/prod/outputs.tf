output "baseline_resources_enabled" {
  description = "Whether baseline resources are enabled for this environment"
  value       = module.app.baseline_resources_enabled
}

output "site_bucket_name" {
  description = "Name of the static site bucket"
  value       = module.app.site_bucket_name
}

output "dynamodb_table_name" {
  description = "Name of the DynamoDB application table"
  value       = module.app.dynamodb_table_name
}

output "api_id" {
  description = "HTTP API ID"
  value       = module.app.api_id
}

output "api_invoke_url" {
  description = "Base invoke URL for the HTTP API"
  value       = module.app.api_invoke_url
}

output "api_execution_arn" {
  description = "Execution ARN for the HTTP API"
  value       = module.app.api_execution_arn
}

output "site_custom_domain_url" {
  description = "HTTPS URL for the site custom domain"
  value       = module.app.site_custom_domain_url
}

output "api_custom_domain_url" {
  description = "HTTPS URL for the API custom domain"
  value       = module.app.api_custom_domain_url
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID"
  value       = module.app.cognito_user_pool_id
}

output "cognito_user_pool_client_id" {
  description = "Cognito user pool app client ID"
  value       = module.app.cognito_user_pool_client_id
}

output "cognito_hosted_ui_domain" {
  description = "Cognito Hosted UI domain"
  value       = module.app.cognito_hosted_ui_domain
}

output "cognito_hosted_ui_base_url" {
  description = "Cognito Hosted UI base URL"
  value       = module.app.cognito_hosted_ui_base_url
}

output "cognito_idp_response_url" {
  description = "OAuth redirect URI to register with social IdPs"
  value       = module.app.cognito_idp_response_url
}

output "lambda_execution_role_arn" {
  description = "Execution role ARN used by deployed Lambda functions"
  value       = module.app.lambda_execution_role_arn
}

output "github_actions_deploy_role_arn" {
  description = "OIDC-assumable IAM role ARN for GitHub Actions deployments"
  value       = module.app.github_actions_deploy_role_arn
}
