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

output "cognito_user_pool_id" {
  description = "Cognito user pool ID"
  value       = module.app.cognito_user_pool_id
}

output "lambda_execution_role_arn" {
  description = "Execution role ARN used by deployed Lambda functions"
  value       = module.app.lambda_execution_role_arn
}
