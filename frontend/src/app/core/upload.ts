export async function uploadToS3(url: string, fields: Record<string, string>, file: File): Promise<void> {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  formData.append('file', file);
  const res = await fetch(url, { method: 'POST', body: formData });
  if (!res.ok) {
    throw new Error(`Échec de l'envoi de l'image (${res.status})`);
  }
}
