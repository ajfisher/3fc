# Deployment preflight reads only the home control partition; no application data or writes.
resource "aws_iam_role_policy" "home_lookup_deploy_read" {
  count = var.create_baseline_resources ? 1 : 0
  name  = "${local.name_prefix}-home-lookup-deploy-read"
  role  = aws_iam_role.github_actions_deploy[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow"
    Action   = ["dynamodb:GetItem"]
    Resource = aws_dynamodb_table.app[0].arn
    Condition = {
      "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["HOME_LOOKUP"] }
      Null                        = { "dynamodb:LeadingKeys" = "false" }
    }
  }] })
}
