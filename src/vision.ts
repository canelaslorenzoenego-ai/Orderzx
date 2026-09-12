/**
 * Native multimodal delivery: hand the model the screenshot itself.
 *
 * Mirrors dsh-android's vision.ts, including its most important design choice —
 * the capture tools here DEGRADE rather than REFUSE on a text-only route. Their
 * primary output is the canonical JSON (url, title, a11y tree, element refs);
 * the image block is an enhancement added only when
 *
 *   (a) the attachment store is mounted,
 *   (b) the calling route's resolved model declares `image` input, and
 *   (c) admission succeeds.
 *
 * Any failure in that chain silently keeps text-only behaviour, so headless
 * profiles, text-only models and older hosts never see a new error. `read_image`
 * in dsh-tool-fs refuses instead, because there the image IS the point. Here it
 * is not: `browser_observe` returns a usable element tree with or without pixels.
 *
 * Everything is typed structurally. Depending on the host's exported types for
 * the attachment/vision surfaces would break an independent-checkout build, and
 * the surfaces are small enough that structural typing is honest.
 *
 * @module @dsh-community/dsh-browser/vision
 */

/** The durable attachment reference an image block carries (plain JSON). */
export interface BrowserImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** Structural face of the `attachments` service (AttachmentStore). */
export interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<BrowserImageRef>
}

/** Structural face of the `llm` service's model-info resolution. */
export interface LlmServiceLike {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    inputModalities?: readonly string[]
  }>
}

/** Structural face of the exec context fields the route gate reads. */
export interface VisionExecLike {
  signal?: AbortSignal
  agent?: {
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
    options?: { provider?: string; model?: string }
  }
}

export interface BrowserVisionServices {
  attachments?: AttachmentStoreLike
  llm?: LlmServiceLike
}

interface ContextLike {
  get?(name: string): unknown
}

/** Resolve the optional vision services. Both come back undefined on hosts that do not mount them. */
export function resolveVisionServices(ctx: unknown): BrowserVisionServices {
  const get = (ctx as ContextLike)?.get?.bind(ctx)
  if (get === undefined) return {}
  const attachments = get('attachments') as AttachmentStoreLike | undefined
  const llm = get('llm') as LlmServiceLike | undefined
  return {
    ...(attachments !== undefined && typeof attachments.saveImage === 'function' ? { attachments } : {}),
    ...(llm !== undefined && typeof llm.resolveModelInfo === 'function' ? { llm } : {}),
  }
}

/**
 * True when the calling route's resolved model declares `image` input.
 *
 * Answers false instead of throwing: a tool result that enters durable history
 * must not carry an image its route cannot replay.
 */
export async function imageInputActive(services: BrowserVisionServices, exec: VisionExecLike): Promise<boolean> {
  const llm = services.llm
  if (llm === undefined || services.attachments === undefined) return false
  try {
    const routed = exec.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    if (provider === undefined || model === undefined) return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return info.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/** Hard ceiling on what we will commit to the durable store. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/**
 * Durably commit one capture and return the plain reference for the result
 * value, or undefined when the store is absent or admission fails. Never throws.
 */
export async function saveCaptureAttachment(
  services: BrowserVisionServices,
  input: { data: Uint8Array; width: number; height: number; mediaType?: string; name?: string },
): Promise<BrowserImageRef | undefined> {
  const store = services.attachments
  if (store === undefined) return undefined
  if (input.data.byteLength === 0 || input.data.byteLength > MAX_ATTACHMENT_BYTES) return undefined
  try {
    const ref = await store.saveImage({
      data: input.data,
      mediaType: input.mediaType ?? 'image/jpeg',
      name: input.name,
    })
    if (typeof ref?.attachmentId !== 'string' || ref.attachmentId.length === 0) return undefined
    return ref
  } catch {
    return undefined
  }
}

/** Output-schema fragment for the optional `image` result field. */
export const IMAGE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    'Durable attachment reference for the capture delivered to the model as an image block '
    + '(present only when the routed model declares image input).',
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    name: { type: 'string' },
  },
} as const

/**
 * Render one canonical JSON value plus, when the value carries an `image` ref,
 * the image block itself — so an image-capable model SEES the page instead of
 * reading a path.
 *
 * Matches the `(args, value)` signature `output.render` is called with. The cast
 * is deliberate: the compiled-against host typings expose the `image`
 * content-block entry structurally only, so the renderer keeps its own block
 * shape to survive an independent-checkout build.
 */
export function renderJsonWithImage(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const blocks: unknown[] = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const image = (value as { image?: BrowserImageRef } | undefined)?.image
  if (image !== undefined && typeof image.attachmentId === 'string') {
    blocks.push({ type: 'image', attachment: image })
  }
  return blocks as Array<{ type: 'text'; text: string }>
}

/** Plain JSON renderer for tools that never produce pixels. */
export function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}
