# 设计文档 — SES 邮件接收转发系统(v1:全量转发到默认邮箱)

> 本期范围(已确认):**不做** AI 内容分类,**不做**收件地址路由。所有收到的邮件
> 一律转发到**默认邮箱(全量归口)**。AI 分类 / 地址路由留待后续版本叠加(见 §9)。

## 1. 整体数据流

```
1. 外部发信人发邮件到 <任意>@brclient.chat(如 support@brclient.chat)
2. brclient.chat 的 MX → inbound-smtp.us-west-2.amazonaws.com
3. SES 接收,匹配 active Receipt Rule Set 里的规则
4. Receipt Rule 执行两个 Action:
   a. S3 Action     → 原始 MIME 写入 S3(key = <prefix>/<messageId>)
   b. Lambda Action → 触发转发 Lambda(传入 messageId、recipients 等元数据)
5. Lambda 读原始邮件 → 重写邮件头 → 转发到默认邮箱(见 §3、§4)
```

## 2. AWS 资源清单(CloudFormation 管理)

| 资源 | 说明 |
|---|---|
| `AWS::S3::Bucket` | 存原始邮件;默认加密;生命周期策略 |
| `AWS::S3::BucketPolicy` | 允许 ses.amazonaws.com PutObject(限本账号) |
| `AWS::SES::ReceiptRuleSet` | rule set(设为 active 目前需额外步骤,见 §8) |
| `AWS::SES::ReceiptRule` | recipients = 接收域名/地址;actions = S3 + Lambda |
| `AWS::Lambda::Function` | forwarder;Node.js 20 |
| `AWS::IAM::Role` | Lambda 角色:s3:GetObject、ses:SendRawEmail、logs:* |
| `AWS::Lambda::Permission` | 允许 ses.amazonaws.com 调用 Lambda |
| SES Domain Identity(brclient.chat) | 验证 + DKIM(可 CFN 或手动) |
| Route53 记录 | MX + 验证 TXT + DKIM CNAME |

> 本期无 Bedrock,IAM 角色**不需要** `bedrock:InvokeModel`。SNS / IM 通道本期不做。

## 3. 转发决策设计(v1:全量归口)

极简,无路由分支:

```
resolveTargets(recipients, parsedMail):
    # 本期所有邮件统一转发到默认邮箱
    return [ DEFAULT_MAILBOX ]
```

- 无 `ADDRESS_ROUTES`,无 `CATEGORY_ROUTES`,无 AI 调用
- 默认邮箱 = **全量归口**,始终且唯一接收所有转发

### 3.1 配置结构(CFN 参数 → Lambda 环境变量)

三项均为**可配置**,通过 CloudFormation 参数注入,含默认值:

| 配置 | 环境变量 | CFN 参数默认值 | 说明 |
|---|---|---|---|
| 默认邮箱(全量归口) | `DEFAULT_MAILBOX` | `you@example.com` | 唯一转发目标,可改 |
| 发件地址 | `FROM_ADDRESS` | `noreply@brclient.chat` | brclient.chat 验证地址 |
| 归档保留天数 | `ARCHIVE_RETENTION_DAYS` | `90` | S3 生命周期过期天数,可改 |
| 桶名 | `S3_BUCKET` | (CFN 生成/参数) | 存原始邮件 |
| S3 前缀 | `S3_PREFIX` | `inbound/` | 与 S3 Action 前缀一致 |

```jsonc
DEFAULT_MAILBOX        = "you@example.com"   // 全量归口,可配置
FROM_ADDRESS           = "noreply@brclient.chat" // brclient.chat 验证地址
ARCHIVE_RETENTION_DAYS = 90                       // S3 生命周期,可配置
S3_BUCKET              = "<桶名,CFN 注入>"
S3_PREFIX              = "inbound/"
```

> `ARCHIVE_RETENTION_DAYS` 同时驱动 S3 桶生命周期规则(过期天数),CFN 里用同一参数。
> 后续叠加 AI/地址路由时,再引入 `ADDRESS_ROUTES` / `CATEGORY_ROUTES`(见 §9),
> 本期保持环境变量最少,降低出错面。

## 4. 转发邮件重写策略

直接原样转出会有问题:原 `From` 是外部地址(SES 不允许用未验证地址发件);
SPF/DKIM 对齐 brclient.chat,原 From 不匹配 → 进垃圾箱。

**重建邮件头**:
```
From:     brclient.chat <noreply@brclient.chat>   # brclient.chat 验证地址
Reply-To: <原始发件人>                              # 回复直达原始发件人
To:       <默认邮箱>
Subject:  [原样,可选加 "[Fwd] " 前缀]
X-Original-From: <原始发件人>
X-Original-To:   <原始收件地址>
正文 + 附件:  原样保留
```

> 本期无 `X-Route-Category`(无分类)。

## 5. Lambda 实现要点(Node.js 20)

依赖:
- `@aws-sdk/client-s3` — 读原始邮件
- `@aws-sdk/client-ses` — SendRawEmail
- `mailparser` — 解析 MIME
- `nodemailer` — 重建带附件的 raw MIME

> 本期**不引入** `@aws-sdk/client-bedrock-runtime`。

伪代码:
```
handler(event):
  ses = event.Records[0].ses
  messageId  = ses.mail.messageId
  recipients = ses.receipt.recipients

  raw    = s3.getObject(S3_BUCKET, S3_PREFIX + messageId)
  parsed = simpleParser(raw)

  rawOut = buildForwardMime({
     from: FROM_ADDRESS, replyTo: parsed.from, to: [DEFAULT_MAILBOX],
     subject: parsed.subject, html/text: parsed.html/text,
     attachments: parsed.attachments,
     headers: { X-Original-From, X-Original-To }
  })

  ses.sendRawEmail({ RawMessage: { Data: rawOut } })
```

错误处理:
- S3 读/解析失败 → 抛异常,SES 异步调用自动重试;原邮件在 S3 可人工补发
- SendRawEmail 失败 → 记 messageId,可配 DLQ + 告警

## 6. IAM 最小权限(Lambda Role)

```jsonc
{
  "Statement": [
    { "Effect":"Allow", "Action":"s3:GetObject",
      "Resource":"arn:aws:s3:::<bucket>/<prefix>/*" },
    { "Effect":"Allow", "Action":"ses:SendRawEmail", "Resource":"*",
      "Condition": { "StringEquals": { "ses:FromAddress": "noreply@brclient.chat" } } },
    { "Effect":"Allow", "Action":["logs:CreateLogStream","logs:PutLogEvents"],
      "Resource":"arn:aws:logs:*:*:log-group:/aws/lambda/*" }
  ]
}
```

> 本期无 `bedrock:InvokeModel`。`ses:SendRawEmail` 用 `ses:FromAddress` 条件限制
> 只能以 brclient.chat 验证地址发件,符合最小权限。

## 7. S3 桶策略(允许 SES 写入)

```jsonc
{
  "Effect": "Allow",
  "Principal": { "Service": "ses.amazonaws.com" },
  "Action": "s3:PutObject",
  "Resource": "arn:aws:s3:::<bucket>/*",
  "Condition": { "StringEquals": { "aws:SourceAccount": "<ACCOUNT_ID>" } }
}
```

## 8. 部署与测试步骤(CloudFormation)

1. `aws cloudformation deploy --template-file template.yaml --stack-name ses-mail-forwarder --region us-west-2 --capabilities CAPABILITY_IAM`
2. SES 验证 `brclient.chat`(TXT + DKIM CNAME 加到 R53)
3. 加 MX:`brclient.chat. MX 10 inbound-smtp.us-west-2.amazonaws.com.`
4. **激活 receipt rule set**:CloudFormation 不直接支持设为 active,需
   `aws ses set-active-receipt-rule-set --rule-set-name <name> --region us-west-2`(或自定义资源)
5. 转发到外部默认邮箱 → 申请移出 SES 沙盒(默认邮箱地址也需先验证,或移出沙盒后放开)
6. 测试:发信到 `support@brclient.chat` → 确认 S3 有对象 → **默认邮箱**收到转发
   → Reply-To 能回到原始发件人 → 附件/正文完整

## 9. 后续叠加(不在本期范围)

按需求方"先做全量转发,后续再叠加"的意见,以下留待后续版本:

- **AI 内容分类**:引入 Bedrock `InvokeModel`,按主题/正文判类别路由;
  失败降级回默认邮箱。届时补 `bedrock:InvokeModel` IAM 权限 + `CATEGORY_ROUTES`。
- **收件地址路由**:`ADDRESS_ROUTES` 精确地址 → 目标接收人。
- **路由表迁 DynamoDB**,支持热更新。
- 附件病毒扫描;转发失败 DLQ + CloudWatch 告警。

## 10. 待落实(交给后续实现 / 多 agent 协作)

- `template.yaml`:CloudFormation 全量资源(本期无 Bedrock)
- `src/forwarder/`:Lambda 代码(解析、重写、发件)
- 默认邮箱地址、From 地址、归档保留天数已定(见 §3.1),作为 CFN 参数默认值可改
- receipt rule set 激活方式(手动命令 vs 自定义资源)
