#!/usr/bin/env node
/**
 * Gimmick Vision MCP Server
 *
 * Bridges Claude Code to a local Qwen2.5-VL instance (or any OpenAI-compatible
 * vision API).  Claude passes an image URL and a prompt; this server forwards
 * the request to the vision model and returns the text response.
 *
 * Environment variables:
 *   VISION_API_BASE  Base URL of the vision server (default: http://host.docker.internal:8081/v1)
 *   VISION_MODEL     Model alias used in API calls (default: qwen2.5-vl-7b)
 *   VISION_TIMEOUT   Request timeout in ms (default: 60000)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios from 'axios';
import { z } from 'zod';

const API_BASE     = (process.env.VISION_API_BASE ?? 'http://host.docker.internal:8081/v1').replace(/\/$/, '');
const MODEL        = process.env.VISION_MODEL   ?? 'qwen2.5-vl-7b';
const TIMEOUT      = parseInt(process.env.VISION_TIMEOUT ?? '60000', 10);
const PANEL_URL    = process.env.GIMMICK_PANEL_URL ?? 'http://host.docker.internal:6081/api/vision';

/** Best-effort push to the gimmick-search control panel vision preview. */
function pushToPanel(label: string, prompt: string, result: string): void {
  axios.post(PANEL_URL, { label, prompt, result }, { timeout: 2000 })
    .catch(() => { /* panel not running — silently ignore */ });
}

async function callVision(imageUrl: string, prompt: string, maxTokens = 1024): Promise<string> {
  const response = await axios.post(
    `${API_BASE}/chat/completions`,
    {
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
    },
    { timeout: TIMEOUT }
  );
  return response.data.choices[0].message.content as string;
}

async function callVisionMulti(imageUrls: string[], prompt: string, maxTokens = 2048): Promise<string> {
  const content: object[] = [
    ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
    { type: 'text', text: prompt },
  ];
  const response = await axios.post(
    `${API_BASE}/chat/completions`,
    {
      model: MODEL,
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens,
      temperature: 0.1,
    },
    { timeout: TIMEOUT }
  );
  return response.data.choices[0].message.content as string;
}

const server = new McpServer({
  name: 'gimmick-vision-mcp',
  version: '1.0.0',
});

server.tool(
  'analyze_image',
  'Analyze a single image from a URL using the local Qwen2.5-VL vision model. Returns a text description or answer based on the prompt.',
  {
    url: z.string().url().describe('HTTP/HTTPS URL of the image to analyze'),
    prompt: z.string().default('Describe this image in detail, including any visible text, product names, specifications, dimensions, or other relevant information.').describe('What to ask about the image'),
    max_tokens: z.number().min(64).max(4096).default(1024).describe('Maximum response length in tokens'),
  },
  async ({ url, prompt, max_tokens }) => {
    try {
      pushToPanel(url, prompt, '…');
      const result = await callVision(url, prompt, max_tokens);
      pushToPanel(url, prompt, result);
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? `Vision API error: ${err.message}${err.response ? ` (${err.response.status}: ${JSON.stringify(err.response.data)})` : ''}`
        : `Unexpected error: ${String(err)}`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  }
);

server.tool(
  'compare_images',
  'Send multiple images to the vision model for comparison or combined analysis. Useful for comparing product variants, reviewing multiple specs, or extracting data from a set of images.',
  {
    urls: z.array(z.string().url()).min(1).max(8).describe('List of HTTP/HTTPS image URLs (max 8)'),
    prompt: z.string().describe('What to compare or analyze across the images'),
    max_tokens: z.number().min(64).max(4096).default(2048).describe('Maximum response length in tokens'),
  },
  async ({ urls, prompt, max_tokens }) => {
    try {
      pushToPanel(urls.join(' | '), prompt, '…');
      const result = await callVisionMulti(urls, prompt, max_tokens);
      pushToPanel(urls[0], prompt, result);
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? `Vision API error: ${err.message}${err.response ? ` (${err.response.status}: ${JSON.stringify(err.response.data)})` : ''}`
        : `Unexpected error: ${String(err)}`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  }
);

server.tool(
  'read_image_text',
  'Extract all visible text from an image (OCR-focused). Useful for reading product labels, specification sheets, screenshots, or any image containing text.',
  {
    url: z.string().url().describe('HTTP/HTTPS URL of the image'),
    language_hint: z.string().default('English').describe('Primary language of text in the image'),
  },
  async ({ url, language_hint }) => {
    const prompt = `Extract all visible text from this image exactly as it appears. Primary language: ${language_hint}. Include all text you can see, preserving layout where meaningful. If the image contains a table or structured data, reproduce that structure.`;
    try {
      pushToPanel(url, prompt, '…');
      const result = await callVision(url, prompt, 2048);
      pushToPanel(url, prompt, result);
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? `Vision API error: ${err.message}`
        : `Unexpected error: ${String(err)}`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  }
);

async function main() {
  console.error(`Gimmick Vision MCP starting`);
  console.error(`  API: ${API_BASE}`);
  console.error(`  Model: ${MODEL}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Gimmick Vision MCP running on stdio');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});