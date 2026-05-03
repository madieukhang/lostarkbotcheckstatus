export function validateMultiaddAttachment(file) {
  if (!file) {
    return '❌ Attach an `.xlsx` file with `action:file`.';
  }
  if (!file.name?.toLowerCase().endsWith('.xlsx')) {
    return `❌ File must be \`.xlsx\` (got \`${file.name}\`).`;
  }
  if (file.size > 1024 * 1024) {
    return `❌ File too large: ${(file.size / 1024).toFixed(1)} KB (max 1 MB).`;
  }
  return null;
}

export async function downloadMultiaddAttachment(file) {
  try {
    const response = await fetch(file.url);
    if (!response.ok) {
      return { ok: false, content: `❌ Failed to download file: HTTP ${response.status}` };
    }
    return { ok: true, buffer: Buffer.from(await response.arrayBuffer()) };
  } catch (err) {
    console.error('[multiadd] Download failed:', err);
    return { ok: false, content: `❌ Failed to download file: \`${err.message}\`` };
  }
}
