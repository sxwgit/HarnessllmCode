/**
 * MiniMax API 连通性测试
 * 验证 Anthropic 兼容端点 + Tool-Use 功能是否正常
 */
import { loadConfig } from './config.js';
import type { LLMMessage, LLMTool } from './types.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { baseURL, apiKey, model } = config.llm;

  console.log('=== MiniMax API 连通性测试 ===\n');
  console.log(`Base URL : ${baseURL}`);
  console.log(`Model    : ${model}`);
  console.log(`API Key  : ${apiKey.substring(0, 12)}...${apiKey.substring(apiKey.length - 8)}`);
  console.log();

  // ---------- Test 1: Basic text generation (no tools) ----------
  console.log('--- Test 1: 基础文本生成 ---');

  const body1 = {
    model,
    max_tokens: 256,
    temperature: 0.7,
    system: '你是一个简洁的助手，每次只回答一句话。',
    messages: [
      { role: 'user', content: '请用一句话介绍你自己。' },
    ],
  };

  const res1 = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body1),
  });

  console.log(`HTTP Status: ${res1.status} ${res1.statusText}`);

  if (!res1.ok) {
    const errText = await res1.text();
    console.error(`请求失败:\n${errText}`);
    process.exit(1);
  }

  const data1 = await res1.json() as any;
  const text1 = (data1.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  console.log(`回复: ${text1}`);
  console.log(`stop_reason: ${data1.stop_reason}`);
  console.log(`usage: input=${data1.usage?.input_tokens}, output=${data1.usage?.output_tokens}`);
  console.log('✓ Test 1 通过\n');

  // ---------- Test 2: Tool-Use ----------
  console.log('--- Test 2: Tool-Use 调用 ---');

  const tools: LLMTool[] = [
    {
      name: 'get_weather',
      description: '获取指定城市的天气信息',
      input_schema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名称' },
        },
        required: ['city'],
      },
    },
  ];

  const body2 = {
    model,
    max_tokens: 512,
    temperature: 0.7,
    messages: [
      { role: 'user', content: '北京今天天气怎么样？' },
    ],
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
  };

  const res2 = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body2),
  });

  console.log(`HTTP Status: ${res2.status} ${res2.statusText}`);

  if (!res2.ok) {
    const errText = await res2.text();
    console.error(`请求失败:\n${errText}`);
    process.exit(1);
  }

  const data2 = await res2.json() as any;
  const toolUseBlocks = (data2.content || []).filter((b: any) => b.type === 'tool_use');

  console.log(`stop_reason: ${data2.stop_reason}`);
  console.log(`Tool-Use 调用数: ${toolUseBlocks.length}`);

  if (toolUseBlocks.length > 0) {
    for (const block of toolUseBlocks) {
      console.log(`  Tool: ${block.name}, Input: ${JSON.stringify(block.input)}`);
    }

    // Send tool result back
    const body3 = {
      model,
      max_tokens: 256,
      messages: [
        { role: 'user', content: '北京今天天气怎么样？' },
        { role: 'assistant', content: data2.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseBlocks[0].id,
            content: JSON.stringify({ city: '北京', temperature: '22°C', weather: '晴', humidity: '45%' }),
          }],
        },
      ],
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
    };

    const res3 = await fetch(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body3),
    });

    if (res3.ok) {
      const data3 = await res3.json() as any;
      const text3 = (data3.content || [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');
      console.log(`  Tool 结果回复: ${text3}`);
      console.log('✓ Test 2 通过 (完整 Tool-Use Loop)\n');
    } else {
      console.log(`  Tool 结果回复失败: ${res3.status}`);
      console.log('⚠ Test 2 部分通过 (Tool 调用成功，结果回传失败)\n');
    }
  } else {
    console.log('⚠ Test 2: 模型未调用工具，直接回复了文本');
    const text2 = (data2.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    console.log(`  回复: ${text2}\n`);
  }

  // ---------- Test 3: 使用 LLMClient 类 ----------
  console.log('--- Test 3: 通过 LLMClient 类调用 ---');
  const { LLMClient } = await import('./llm/client.js');
  const client = new LLMClient(config.llm);

  const response = await client.generateWithSystem(
    '你是一个测试助手，只回复"OK"两个字母。',
    '请回复确认。',
  );
  console.log(`LLMClient 回复: ${response}`);
  console.log(`Token 用量: ${JSON.stringify(client.getTokenUsage())}`);
  console.log('✓ Test 3 通过\n');

  console.log('=== 全部测试通过 ===');
}

main().catch((err) => {
  console.error('测试失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
