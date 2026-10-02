// Deletes a reported drop by its code, using the ADMIN_TOKEN secret as the key.
const form = document.querySelector('#takedown');
const result = document.querySelector('#result');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = form.elements.code.value.trim();
  result.textContent = 'Removing…';
  try {
    const res = await fetch('/api/admin/takedown', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${form.elements.key.value}` },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error('Removing drops is switched off. Add the ADMIN_TOKEN secret to the Worker first.');
    if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
    result.textContent = data.removed
      ? `Drop ${code} is deleted.`
      : `No live drop has the code ${code}. It has probably expired already.`;
  } catch (err) {
    result.textContent = err.message;
  }
});
