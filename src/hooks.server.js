import { initGitRepos, handleGitRequest } from './lib/server/git';
import { env } from '$env/dynamic/private';

export async function init() {
    initGitRepos();
}

export async function handle({ event, resolve }) {
    const { url } = event;

    if (url.pathname.startsWith('/git/')) {
        return handleGitRequest(event, env.GIT_PROJECT_ROOT);
    }

    return resolve(event);
}
