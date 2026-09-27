#!/usr/bin/env bash
# 从 CloudFormation stack 输出取 SES Receipt Rule Set 名并激活它。
# CloudFormation 不能直接把 AWS::SES::ReceiptRuleSet 设为 active,需要这一步手工/脚本调用。
# 用法: scripts/activate-ruleset.sh [stack-name] [region]
set -euo pipefail

STACK_NAME="${1:-ses-mail-forwarder}"
REGION="${2:-us-west-2}"

echo "==> 从 stack '${STACK_NAME}' (region ${REGION}) 读取 ReceiptRuleSetName ..."
RULE_SET_NAME=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ReceiptRuleSetName'].OutputValue" \
  --output text)

if [[ -z "${RULE_SET_NAME}" || "${RULE_SET_NAME}" == "None" ]]; then
  echo "错误: 未能从 stack 输出中找到 ReceiptRuleSetName,请确认模板已导出该 Output。" >&2
  exit 1
fi

echo "==> 找到 rule set: ${RULE_SET_NAME}"
echo "==> 激活 receipt rule set ..."
aws ses set-active-receipt-rule-set \
  --rule-set-name "${RULE_SET_NAME}" \
  --region "${REGION}"

echo "==> 校验当前 active rule set ..."
ACTIVE_NAME=$(aws ses describe-active-receipt-rule-set \
  --region "${REGION}" \
  --query 'Metadata.Name' \
  --output text)

if [[ "${ACTIVE_NAME}" == "${RULE_SET_NAME}" ]]; then
  echo "成功: 当前 active rule set = ${ACTIVE_NAME}"
else
  echo "警告: 当前 active rule set (${ACTIVE_NAME}) 与期望 (${RULE_SET_NAME}) 不一致。" >&2
  exit 1
fi
