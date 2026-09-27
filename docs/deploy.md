# 部署与验证指南

> 对应设计文档 [design.md §8](./design.md#8-部署与测试步骤cloudformation)。本文档只描述部署命令、
> 手工/命令行验证步骤,不包含 `template.yaml` / Lambda 代码实现。

约定:
- Region:`us-west-2`
- Stack 名:`ses-mail-forwarder`
- 域名:`brclient.chat`(已在 Route 53 托管)
- 默认邮箱(全量归口):见 `design.md §3.1` 的 `DEFAULT_MAILBOX` 参数(默认 `you@example.com`)

---

## 1. 部署 CloudFormation Stack

`template.yaml` 中 Lambda 用的是本地目录 `Code: src/forwarder/`,**不能直接对 `template.yaml`
执行 `aws cloudformation deploy`**,必须先安装依赖 → `package` 上传代码到 S3 暂存桶 → 对生成的
`packaged.yaml` 执行 `deploy`。以下命令均在项目根目录执行。

### 1.1 安装 Lambda 依赖

`src/forwarder` 依赖 `mailparser`、`nodemailer`,`nodejs20.x` 运行时只内置 AWS SDK v3,
不含这两个包。打包前必须先在 `src/forwarder/` 安装依赖,让 `node_modules` 一起被打进 zip,
否则 Lambda 运行时会报 `Cannot find module 'mailparser'`:

```bash
(cd src/forwarder && npm install --omit=dev)
```

### 1.2 准备暂存桶并打包

`aws cloudformation package` 会把 `src/forwarder/`(含 `node_modules`)压缩上传到暂存桶,
并输出把 `Code` 替换为 S3 地址的 `packaged.yaml`。暂存桶只需创建一次(已有可复用则跳过创建):

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ARTIFACT_BUCKET=ses-mail-forwarder-artifacts-${ACCOUNT_ID}-us-west-2

# 仅首次:创建暂存桶(已存在则跳过)
aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" 2>/dev/null || \
  aws s3api create-bucket \
    --bucket "$ARTIFACT_BUCKET" \
    --region us-west-2 \
    --create-bucket-configuration LocationConstraint=us-west-2

aws cloudformation package \
  --template-file template.yaml \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --output-template-file packaged.yaml \
  --region us-west-2
```

### 1.3 部署

```bash
aws cloudformation deploy \
  --template-file packaged.yaml \
  --stack-name ses-mail-forwarder \
  --region us-west-2 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      DefaultMailbox=you@example.com \
      FromAddress=noreply@brclient.chat \
      ArchiveRetentionDays=90
```

> `DefaultMailbox=you@example.com` 为占位符,部署时替换为真实的归口邮箱地址(该地址在 SES 沙盒下需先验证)。
> 每次修改 `src/forwarder/` 代码或依赖后,都要重新执行 1.1 → 1.2 → 1.3。

首次部署前可在 1.3 命令后加 `--no-execute-changeset` 只生成 change set 先看 diff(可选);
重复部署无变更时可加 `--no-fail-on-empty-changeset` 避免报错。部署完成后取关键输出:

```bash
aws cloudformation describe-stacks \
  --stack-name ses-mail-forwarder \
  --region us-west-2 \
  --query 'Stacks[0].Outputs' \
  --output table
```

关注这几项输出(键名与 `template.yaml` 的 `Outputs` 段一致):
- `ReceiptRuleSetName` — 第 4 步激活时要用的 rule set 名
- `ArchiveBucketName` — 归档桶名(端到端测试第 6 步要检查)
- `LambdaFunctionName` — 转发 Lambda 名(排障用)

---

## 2. SES 域名验证(brclient.chat)

Stack 部署会创建 SES Domain Identity,但**域名验证记录需要写入 Route 53**(CFN 里如果用了
`AWS::Route53::RecordSet` 自动写入则跳过手工步骤,以下为手工/核对方式)。

1. 查看验证 TXT 值和 DKIM tokens:

```bash
aws ses get-identity-verification-attributes \
  --identities brclient.chat \
  --region us-west-2

aws ses get-identity-dkim-attributes \
  --identities brclient.chat \
  --region us-west-2
```

2. 在 Route 53 对应 Hosted Zone 加记录:

| 记录类型 | 名称 | 值 |
|---|---|---|
| TXT | `_amazonses.brclient.chat` | SES 返回的 verification token |
| CNAME × 3 | `<dkim-token-N>._domainkey.brclient.chat` | `<dkim-token-N>.dkim.amazonses.com` |

3. 确认验证通过(可能需要几分钟到数十分钟传播):

```bash
aws ses get-identity-verification-attributes \
  --identities brclient.chat \
  --region us-west-2 \
  --query 'VerificationAttributes.*.VerificationStatus'
# 期望输出: "Success"
```

---

## 3. MX 记录

在 Route 53 `brclient.chat` Hosted Zone 加一条 MX 记录(接收域名邮件的入口):

```
brclient.chat.   MX   10 inbound-smtp.us-west-2.amazonaws.com.
```

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id <HOSTED_ZONE_ID> \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "brclient.chat",
        "Type": "MX",
        "TTL": 300,
        "ResourceRecords": [{ "Value": "10 inbound-smtp.us-west-2.amazonaws.com" }]
      }
    }]
  }'
```

验证:

```bash
dig +short MX brclient.chat
```

---

## 4. 激活 Receipt Rule Set

**CloudFormation 不能直接把 `AWS::SES::ReceiptRuleSet` 设为 active**,必须额外调用
`set-active-receipt-rule-set`(或在模板里用 Custom Resource 包一层,本期未做,走手工命令):

```bash
aws ses set-active-receipt-rule-set \
  --rule-set-name <ReceiptRuleSetName> \
  --region us-west-2
```

`<ReceiptRuleSetName>` 取自第 1 步 CFN Outputs 的 `ReceiptRuleSetName`。

确认已激活:

```bash
aws ses describe-active-receipt-rule-set --region us-west-2
```

期望返回的 `Metadata.Name` 与目标 rule set 名一致,且 `Rules` 里包含处理
`brclient.chat` 收件的规则(S3 Action + Lambda Action)。

也可以用 [scripts/activate-ruleset.sh](../scripts/activate-ruleset.sh) 一步完成
「从 stack 输出取 rule set 名 → 激活 → 校验」。

---

## 5. SES 沙盒说明

新账号 / 未申请生产权限的 SES 默认处于**沙盒模式**,限制:
- 只能发信给**已验证的邮箱地址**或已验证域名下的地址
- 每 24 小时发信配额、发信速率都很低

本项目转发动作本质是"用 SES 发一封新邮件给默认邮箱",因此受沙盒限制:

- **短期验证/测试**:直接验证默认邮箱地址即可收到转发邮件

  ```bash
  aws ses verify-email-identity \
    --email-address you@example.com \
    --region us-west-2
  ```

  之后到该邮箱点击 SES 发来的验证链接完成验证。

- **正式使用(默认邮箱是任意外部地址,不想每次都手动验证)**:需要申请
  **移出沙盒**(Move out of the SES sandbox),在 SES 控制台 “Account dashboard”
  或通过 Support Case 提交生产访问请求,说明用途(域名邮件转发)、预计发信量。
  审批通常需要 24 小时左右。

> 移出沙盒前,`DEFAULT_MAILBOX` 必须先验证,否则转发 Lambda 调用
> `SendRawEmail` 会报 `MessageRejected: Email address is not verified`。

---

## 6. 端到端测试

前置:第 1~5 步全部完成(stack 部署、域名验证通过、MX 生效、rule set 已激活、
默认邮箱已验证或已出沙盒)。

1. **发信**:用外部邮箱给 `support@brclient.chat` 发一封带附件的测试邮件。

2. **确认 S3 有对象**(原始 MIME 已归档):

   ```bash
   aws s3 ls s3://<ArchiveBucketName>/inbound/ --region us-west-2
   ```

   应能看到以 SES `messageId` 命名的新对象,时间与发信时间吻合。

3. **确认默认邮箱收到转发邮件**:检查 `DEFAULT_MAILBOX`(如 `you@example.com`)
   收件箱(注意先查垃圾箱,首次可能被误判)。核对邮件头:
   - `From`:`noreply@brclient.chat`(或模板配置的 `FROM_ADDRESS`)
   - `Reply-To`:原始发件人地址
   - `X-Original-From` / `X-Original-To`:原始发件人 / 原始收件地址(`support@brclient.chat`)

4. **确认 Reply-To 可回到原发件人**:在收到的转发邮件上点“回复”,确认收件人
   自动填的是原始发件人地址(而不是 `noreply@brclient.chat` 或默认邮箱自己)。

5. **确认附件完整**:对比转发邮件里的附件与原始发信附件,文件名、大小、内容一致
   (可用 `md5`/`sha256` 校验)。

6. **排障**(任一步失败时):

   ```bash
   # 看 Lambda 日志
   aws logs tail /aws/lambda/<LambdaFunctionName> --region us-west-2 --since 15m

   # 确认 receipt rule set 是否真的 active,规则条件(recipients)是否覆盖 support@brclient.chat
   aws ses describe-active-receipt-rule-set --region us-west-2
   ```
