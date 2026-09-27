'use strict';

const { GetObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { SendRawEmailCommand, SESClient } = require('@aws-sdk/client-ses');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const s3 = new S3Client({});
const ses = new SESClient({});

/**
 * Version 1 always forwards every message to the single configured mailbox.
 */
function resolveTargets(_recipients, _parsedMail) {
  return [requiredEnv('DEFAULT_MAILBOX')];
}

async function handler(event) {
  const sesRecord = event?.Records?.[0]?.ses;
  if (!sesRecord) {
    throw new Error('Invalid SES event: Records[0].ses is required');
  }

  const messageId = sesRecord.mail?.messageId;
  if (!messageId) {
    throw new Error('Invalid SES event: mail.messageId is required');
  }

  const bucket = requiredEnv('S3_BUCKET');
  const prefix = process.env.S3_PREFIX || '';
  const fromAddress = requiredEnv('FROM_ADDRESS');
  const recipients = sesRecord.receipt?.recipients || [];
  const targets = resolveTargets(recipients);

  const object = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: `${prefix}${messageId}`,
    }),
  );

  if (!object.Body) {
    throw new Error(`S3 object body is empty for message ${messageId}`);
  }

  const source = await bodyToBuffer(object.Body);
  const parsed = await simpleParser(source);
  const originalFrom = parsed.from?.text || sesRecord.mail?.source || '';
  const originalTo = recipients.length > 0
    ? recipients.join(', ')
    : parsed.to?.text || '';

  const rawMessage = await buildForwardMime({
    parsed,
    fromAddress,
    targets,
    originalFrom,
    originalTo,
  });

  const result = await ses.send(
    new SendRawEmailCommand({
      RawMessage: { Data: rawMessage },
    }),
  );

  console.info('Forwarded email', {
    sourceMessageId: messageId,
    outboundMessageId: result.MessageId,
    targets,
  });

  return {
    messageId: result.MessageId,
    targets,
  };
}

async function buildForwardMime({
  parsed,
  fromAddress,
  targets,
  originalFrom,
  originalTo,
}) {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });

  const mail = {
    from: fromAddress,
    to: targets,
    subject: parsed.subject || '',
    text: parsed.text,
    html: parsed.html || undefined,
    attachments: (parsed.attachments || []).map((attachment) => ({
      filename: attachment.filename || undefined,
      content: attachment.content,
      contentType: attachment.contentType,
      contentDisposition: attachment.contentDisposition,
      cid: attachment.cid,
      contentTransferEncoding: attachment.transferEncoding,
      headers: attachment.headers,
    })),
    headers: {
      'X-Original-From': headerValue(originalFrom),
      'X-Original-To': headerValue(originalTo),
    },
  };

  if (parsed.from?.value?.length) {
    mail.replyTo = parsed.from.value;
  } else if (originalFrom) {
    mail.replyTo = originalFrom;
  }

  const info = await transport.sendMail(mail);
  return info.message;
}

async function bodyToBuffer(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function headerValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

module.exports = {
  handler,
  resolveTargets,
};
