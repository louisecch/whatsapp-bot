const axios = require('axios')
const { bot, getGPTResponse, getDallEResponse } = require('../lib')

async function openAIRespond({ prompt, image }) {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim()
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY')
  }

  const model = (process.env.OPENAI_MODEL || '').trim() || 'gpt-4o-mini'

  const content = [{ type: 'input_text', text: prompt }]
  if (image?.base64 && image?.mimetype) {
    content.push({
      type: 'input_image',
      image_url: `data:${image.mimetype};base64,${image.base64}`,
    })
  }

  const { data } = await axios.post(
    'https://api.openai.com/v1/responses',
    {
      model,
      input: [
        {
          role: 'user',
          content,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  )

  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim()
  }

  const chunks = []
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') chunks.push(part.text)
    }
  }
  const text = chunks.join('\n').trim()
  return text || 'No response text returned.'
}

bot(
  {
    pattern: 'gpt ?(.*)',
    desc: 'ChatGPT fun',
    type: 'AI',
  },
  async (message, match) => {
    if (!match)
      return await message.send(
        '>*Example :\n- gpt What is the capital of France?\n- gpt Whats in this image?(reply to a image)'
      )
    let image = null
    if (message.reply_message && message.reply_message.image) {
      const buf = await message.reply_message.downloadMediaMessage()
      image = {
        base64: Buffer.from(buf).toString('base64'),
        mimetype: message.reply_message.mimetype || 'image/jpeg',
      }
    }

    let res
    if ((process.env.OPENAI_API_KEY || '').trim()) {
      res = await openAIRespond({ prompt: match, image })
    } else {
      // fallback to whatever backend this repo ships with
      res = await getGPTResponse(match, message.id, null)
    }
    await message.send(res, { quoted: message.data })
  }
)

bot(
  {
    pattern: 'dall ?(.*)',
    desc: 'dall image generator',
    type: 'AI',
  },
  async (message, match) => {
    if (!match)
      return await message.send(
        '*Example : dall a close up, studio photographic portrait of a white siamese cat that looks curious, backlit ears*'
      )
    const res = await getDallEResponse(match, message.id)
    await message.sendFromUrl(res)
  }
)
