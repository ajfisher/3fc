# Durable transport belongs to Terraform; Serverless owns functions and mappings.
# Provision before deploying player-history. Provisioning does not enable consumers.
resource "aws_sqs_queue" "player_history_dead" {
  count                     = var.create_baseline_resources ? 1 : 0
  name                      = "${local.name_prefix}-player-history-dead"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.app_tags
}

resource "aws_sqs_queue" "player_history_dispatch_dead" {
  count                     = var.create_baseline_resources ? 1 : 0
  name                      = "${local.name_prefix}-player-history-dispatch-dead"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.app_tags
}

resource "aws_sqs_queue" "player_history" {
  count                      = var.create_baseline_resources ? 1 : 0
  name                       = "${local.name_prefix}-player-history"
  visibility_timeout_seconds = 360
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.player_history_dead[0].arn
    maxReceiveCount     = 5
  })
  tags = local.app_tags
}

resource "aws_sqs_queue_redrive_allow_policy" "player_history" {
  count     = var.create_baseline_resources ? 1 : 0
  queue_url = aws_sqs_queue.player_history_dead[0].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.player_history[0].arn]
  })
}

locals {
  history_lambda_assume = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" }
  }] })
}

resource "aws_iam_role" "player_history_dispatch" {
  count              = var.create_baseline_resources ? 1 : 0
  name               = "${local.name_prefix}-player-history-dispatch"
  assume_role_policy = local.history_lambda_assume
  tags               = local.app_tags
}

resource "aws_iam_role" "player_history_worker" {
  count              = var.create_baseline_resources ? 1 : 0
  name               = "${local.name_prefix}-player-history-worker"
  assume_role_policy = local.history_lambda_assume
  tags               = local.app_tags
}

resource "aws_iam_role_policy" "player_history_dispatch" {
  count = var.create_baseline_resources ? 1 : 0
  role  = aws_iam_role.player_history_dispatch[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"], Resource = aws_dynamodb_table.app[0].stream_arn },
    { Effect = "Allow", Action = ["dynamodb:ListStreams"], Resource = "*" },
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.player_history[0].arn, aws_sqs_queue.player_history_dispatch_dead[0].arn] },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:${data.aws_partition.current.partition}:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/3fc-${var.env}-player-history-dispatch:*" }
  ] })
}

resource "aws_iam_role_policy" "player_history_worker" {
  count = var.create_baseline_resources ? 1 : 0
  role  = aws_iam_role.player_history_worker[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    # DynamoDB transactions authorise their constituent item operations.
    {
      Sid      = "HistoryReadAndCheck"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
      Resource = aws_dynamodb_table.app[0].arn
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["PLAYER#*", "GAME#*", "LEAGUE#*", "PLAYER_HISTORY#*", "PLAYER_HISTORY", "PLAYER_IDENTITY", "PLAYER_IDENTITY_TOMBSTONE"] }
        Null                      = { "dynamodb:LeadingKeys" = "false" }
      }
    },
    {
      Sid      = "HistoryWriteDerived"
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem"]
      Resource = aws_dynamodb_table.app[0].arn
      # Jobs/sweeps/acknowledgements share LEAGUE partitions with source rows.
      # LeadingKeys cannot restrict sort keys; runtime code owns that boundary.
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["PLAYER_HISTORY#*", "LEAGUE#*"] }
        Null                      = { "dynamodb:LeadingKeys" = "false" }
      }
    },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:SendMessage"], Resource = aws_sqs_queue.player_history[0].arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:${data.aws_partition.current.partition}:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/3fc-${var.env}-player-history-worker:*" }
  ] })
}

resource "aws_iam_role_policy" "player_history_deploy_discovery" {
  count = var.create_baseline_resources ? 1 : 0
  role  = aws_iam_role.github_actions_deploy[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:DescribeTable"], Resource = aws_dynamodb_table.app[0].arn },
    { Effect = "Allow", Action = ["sqs:GetQueueUrl", "sqs:GetQueueAttributes"], Resource = [aws_sqs_queue.player_history[0].arn, aws_sqs_queue.player_history_dead[0].arn, aws_sqs_queue.player_history_dispatch_dead[0].arn] }
  ] })
}

# These named alarms expose failure/lag without inventing an alert recipient.
# Operators attach their notification destination as part of activation.
resource "aws_cloudwatch_metric_alarm" "player_history_dead" {
  for_each = var.create_baseline_resources ? {
    worker   = aws_sqs_queue.player_history_dead[0].name
    dispatch = aws_sqs_queue.player_history_dispatch_dead[0].name
  } : {}
  alarm_name          = "${local.name_prefix}-player-history-${each.key}-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = each.value }
  tags                = local.app_tags
}

resource "aws_cloudwatch_metric_alarm" "player_history_lag" {
  count               = var.create_baseline_resources ? 1 : 0
  alarm_name          = "${local.name_prefix}-player-history-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 300
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.player_history[0].name }
  tags                = local.app_tags
}

resource "aws_cloudwatch_metric_alarm" "player_history_errors" {
  for_each            = var.create_baseline_resources ? toset(["dispatch", "worker"]) : toset([])
  alarm_name          = "${local.name_prefix}-player-history-${each.key}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = "3fc-${var.env}-player-history-${each.key}" }
  tags                = local.app_tags
}

resource "aws_cloudwatch_metric_alarm" "player_history_stream_lag" {
  count               = var.create_baseline_resources ? 1 : 0
  alarm_name          = "${local.name_prefix}-player-history-stream-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "IteratorAge"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Maximum"
  threshold           = 300000
  treat_missing_data  = "notBreaching"
  dimensions          = { FunctionName = "3fc-${var.env}-player-history-dispatch" }
  tags                = local.app_tags
}

output "player_history_stream_arn" { value = try(aws_dynamodb_table.app[0].stream_arn, null) }
output "player_history_queue_url" { value = try(aws_sqs_queue.player_history[0].id, null) }
output "player_history_queue_arn" { value = try(aws_sqs_queue.player_history[0].arn, null) }
output "player_history_dead_queue_arn" { value = try(aws_sqs_queue.player_history_dead[0].arn, null) }
output "player_history_dispatch_dead_queue_arn" { value = try(aws_sqs_queue.player_history_dispatch_dead[0].arn, null) }
output "player_history_dispatch_role_arn" { value = try(aws_iam_role.player_history_dispatch[0].arn, null) }
output "player_history_worker_role_arn" { value = try(aws_iam_role.player_history_worker[0].arn, null) }
