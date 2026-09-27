# SES 邮件接收转发系统 (WorkMail 替代方案)

## 背景

AWS WorkMail 即将下线。本项目用 **SES Email Receiving + S3 + Lambda** 替代 WorkMail 的收件与转发能力。

> 本方案只覆盖「域名邮件的接收 + 归档 + 转发」,**不提供** IMAP/POP、Webmail、日历/联系人等完整邮箱能力。当前需求仅为网站留的邮箱(如 `support@brclient.chat`)收信后转发到默认邮箱。

## 当前状态

**v1(全量转发)已实现并端到端验证通过。** 收到 `*@brclient.chat` 的邮件 → 原始 MIME 归档到 S3 → Lambda 转发到默认邮箱(`you@example.com`)。本期不含 AI 内容分类与按地址路由(见[后续规划](#后续规划))。

## 需求(v1 已确认)

1. **只接收邮件** —— 网站上留的地址,如 `support@brclient.chat`
2. **不主动发邮件** —— 不发营销/通知邮件(转发动作除外)
3. **收信 → 存 S3 → 全量转发到默认邮箱** —— v1 不做地址/内容路由,所有邮件统一转发到默认邮箱

> ⚠️ 「转发」本质是发邮件,会用到 SES 发件能力,受**沙盒限制**约束(见 `docs/deploy.md §5`)。

## 基本参数

| 参数 | 值 |
|---|---|
| 测试域名 | `brclient.chat`(已在 Route 53) |
| Region | `us-west-2` |
| MX 记录 | `brclient.chat. MX 10 inbound-smtp.us-west-2.amazonaws.com.` |
| From(发件) | `noreply@brclient.chat`(可配置 `FromAddress`) |
| 默认邮箱 | `you@example.com`(可配置 `DefaultMailbox`,全量归口) |
| 归档保留 | 90 天(可配置 `ArchiveRetentionDays`) |
| Lambda 运行时 | Node.js 20 |
| IaC | CloudFormation(打包上传部署) |

## 架构(v1 全量转发)

```
                         MX 记录 (us-west-2)
发信人 ─────────────────────────────▶ inbound-smtp.us-west-2.amazonaws.com
                                              │
                                       SES Receipt Rule (active)
                                       recipients: brclient.chat
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ▼ (Action 1)                     ▼ (Action 2)
                   S3Action                          LambdaAction
              归档原始 MIME 到                  ┌──────────────────────────────┐
              s3://<bucket>/inbound/           │ 1. 从 S3 读原始 MIME          │
                                               │ 2. mailparser 解析            │
                                               │ 3. 目标 = 默认邮箱(v1 全量)    │
                                               │ 4. From→noreply, 原发件人→ReplyTo│
                                               │ 5. SES SendRawEmail 转发       │
                                               └──────────────────────────────┘
                                                              │
                                                              ▼
                                                    默认邮箱 (you@example.com)
```

## 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 发件方式 | SES API `SendRawEmail` | 走 IAM 角色,无需 SMTP 凭证管理 |
| 邮件存储 | S3 存完整 MIME | 保留附件/格式,便于归档与后续处理 |
| 路由方式(v1) | 全量转发到默认邮箱 | v1 先打通链路,路由/AI 分类留后续 |
| From 处理 | 换成 `noreply@brclient.chat`,原发件人放 Reply-To | 避免 SPF/DKIM 校验失败进垃圾箱,回复能回到原发件人 |
| IaC | CloudFormation | 打包上传即部署 |

## 部署

见 [`docs/deploy.md`](./docs/deploy.md):安装 Lambda 依赖 → `cloudformation package` 上传代码 → `deploy` → SES 域名验证(TXT+DKIM)→ MX → 激活 receipt rule set → 沙盒说明 → 端到端测试。激活脚本见 [`scripts/activate-ruleset.sh`](./scripts/activate-ruleset.sh)。

## 前置条件 / 约束

- **Region**: us-west-2,MX 必须指向 `inbound-smtp.us-west-2.amazonaws.com`
- **域名验证**: `brclient.chat` 需在 SES 完成验证(TXT + DKIM)
- **沙盒**: 沙盒模式下转发目标(默认邮箱)必须先在 SES 验证;转发到任意外部地址需申请移出沙盒
- **S3 桶策略**: 允许 `ses.amazonaws.com` 写入(模板已配置)

## 目录结构

```
ses-mail-forwarder/
├── README.md              # 本文件
├── template.yaml          # CloudFormation 模板(S3 + SES Rule + Lambda + IAM)
├── docs/
│   ├── requirements.md    # 需求文档
│   ├── design.md          # 设计文档
│   └── deploy.md          # 部署与验证指南
├── scripts/
│   └── activate-ruleset.sh # 激活 SES receipt rule set
└── src/
    └── forwarder/         # 转发 Lambda 代码 (Node.js 20)
        ├── index.js
        └── package.json
```

## 后续规划

本期为 v1 全量转发,后续可叠加(见 `docs/design.md §9`):

- AI 内容分类(Bedrock)
- 按收件地址路由
- 路由表迁移到 DynamoDB
- DLQ + 告警
