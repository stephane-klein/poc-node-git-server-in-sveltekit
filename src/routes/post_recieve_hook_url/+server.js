import { json } from '@sveltejs/kit';
export const trailingSlash = 'always';

export async function POST({ request }) {
    try {
        const body = await request.json();
        console.log('Received JSON:', body);

        return json({ success: true, received: body });
    } catch (error) {
        console.error('Error parsing JSON:', error);
        return json({ error: 'Invalid JSON' }, { status: 400 });
    }
}
