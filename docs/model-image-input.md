# Model image input

`apps/api/src/agent/image-preparation.ts` is the shared server preparation layer.
Chat prepares resolved **original** attachments before calculating output room;
canonical Gateway, native/streaming requests and direct ModelClient requests
prepare before context admission, reservation and transport. Nothing writes a
model derivative over an attachment or uses the UI preview as model input.

## Policy

Defaults are application policy, not discovered provider/model capabilities:

- Prefer readable study text: local `original` tier, 6000px longest edge and
  10 million pixels. `high` tier uses 2048px and 2.56 million pixels.
- Default output bytes: 20 MiB; Anthropic Messages envelope uses 5 MiB.
- Independently enforce input safety: 32 MB per image, 40 million decoded pixels,
  64 MB of images per request, 64 image occurrences including history. Context
  admission may allow fewer. Existing upload/attachment limits remain unchanged.
- Decode strictly, honor EXIF orientation, use the first animated frame. Preserve
  valid PNG/JPEG/WebP bytes when within policy; otherwise produce PNG or lossless
  WebP, reducing dimensions further only if needed for the byte limit.
- No remote URL fetching, automatic crops/tiling, or cross-request image cache.

An exact saved model can override `ModelOverrides.imageInput` (in its `savedModels`
preference entry). No model-name matching or assumptions that OpenAI-compatible
endpoints share OpenAI limits:

```json
{
  "providerId": "my-provider",
  "model": "exact-model-id",
  "imageInput": {
    "quality": "original",
    "maxEdge": 6000,
    "maxPixels": 10000000,
    "maxBytes": 20971520
  }
}
```

`original` is a **local resolution tier**, not a promise to send unbounded files
or the nonportable API `detail: original`. OpenAI-shaped parts default to
`detail: high`; explicit native detail values remain intact. The settings UI
does not yet expose these advanced image overrides.

## Budgeting

`boundedRequest` no longer resizes, rewrites image detail, rejects images over
2048px, or enforces a four-image count. It excludes image base64 from text
estimation and reserves against actual raster dimensions: at least 16384 tokens
per image, or four tokens per 32px patch, whichever is greater. This deliberately
conservative envelope is **not a provider tokenizer/billing formula**. Provider
usage remains authoritative and overrun handling is unchanged. Synchronous
Gateway planning estimates may conservatively count unprepared source images;
actual admission and reservations always use prepared wire images.

Failures have stable `model_image_*` / `invalid_model_image_policy` codes; tool
recovery explains valid formats, safe limits, crop/reupload and configuration.

## Offline regression

```sh
npx tsx --test scripts/test-model-images.mjs
npx tsx scripts/test-bot-request-budget.mjs
npm run test:chat:attachments:references
npm run test:chat:attachments:server
npm run test:model-gateway
```

Includes the previously rejected **1087×2560** shape, lossless source preservation,
per-model resizing, all three wire protocols, EXIF, corruption and actual Gateway
reservation. Server task coverage exercises upload, replay, continuation and retry.
