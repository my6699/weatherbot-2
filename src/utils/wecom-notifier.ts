// 企业微信（WeCom）群机器人通知模块。
//
// 用法：
// 1. 在 https://work.weixin.qq.com/api/doc/90000/90136/91770 创建群机器人。
// 2. 把 Webhook URL 填到 .env 的 WECOM_WEBHOOK_URL 字段。
// 3. 调用 sendWeComMessage() 发通知。
//
// 免费，每天每个机器人 1000 条消息，完全够用。

// Node.js 20+ 内置 fetch，不需要额外导入

const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL ?? '';

export interface WeComMarkdownMessage {
  msgtype: 'markdown';
  markdown: {
    content: string;
  };
}

export interface WeComTextMessage {
  msgtype: 'text';
  text: {
    content: string;
    mentioned_list?: string[];
  };
}

/**
 * 发送 Markdown 消息到企业微信群机器人。
 * 返回 true 表示发送成功，false 表示失败（配置缺失或网络错误）。
 */
export async function sendWeComMarkdown(content: string): Promise<boolean> {
  if (!WECOM_WEBHOOK_URL) {
    console.warn('[WeCom] WECOM_WEBHOOK_URL 未配置，跳过消息发送');
    return false;
  }

  const body: WeComMarkdownMessage = {
    msgtype: 'markdown',
    markdown: { content },
  };

  try {
    const res = await fetch(WECOM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode !== 0) {
      console.error(`[WeCom] 发送失败: errcode=${data.errcode ?? '?'} errmsg=${data.errmsg ?? '?'}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[WeCom] 发送异常:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * 发送纯文本消息到企业微信群机器人。
 * mentioned_list 可选，传 '@all' 可以 @所有人。
 */
export async function sendWeComText(content: string, mentioned_list?: string[]): Promise<boolean> {
  if (!WECOM_WEBHOOK_URL) {
    console.warn('[WeCom] WECOM_WEBHOOK_URL 未配置，跳过消息发送');
    return false;
  }

  const body: WeComTextMessage = {
    msgtype: 'text',
    text: { content, ...(mentioned_list ? { mentioned_list } : {}) },
  };

  try {
    const res = await fetch(WECOM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode !== 0) {
      console.error(`[WeCom] 发送失败: errcode=${data.errcode ?? '?'} errmsg=${data.errmsg ?? '?'}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[WeCom] 发送异常:', error instanceof Error ? error.message : String(error));
    return false;
  }
}