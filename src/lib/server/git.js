import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import { spawn, execSync } from 'child_process';
import dedent from 'string-dedent';
import { env } from '$env/dynamic/private';

export function initGitRepos() {
    ['repos1', 'repos2', 'repos3'].forEach((repoName) => {
        const repoPath = path.join(env.GIT_PROJECT_ROOT, `${repoName}.git`);
        if (existsSync(repoPath)) {
            console.log(`"${repoName}" git bare repository already exists`);
        } else {
            console.log(`Create "${repoName}" git bare repository`);
            execSync(
                `
                    mkdir -p "${repoPath}" && \\
                    cd "${repoPath}" && \
                    git init --bare && \\
                    git config http.receivepack true && \\
                    git config http.uploadpack true
                `,
                { stdio: ['ignore', 'ignore', 'inherit'] }
            );

        }
        writeFileSync(
            path.join(repoPath, 'hooks/post-receive'),
            dedent`
                #!/bin/bash

                # Obtenir les informations du push
                while read oldrev newrev refname; do
                    branch=$(git rev-parse --symbolic --abbrev-ref $refname)

                    curl -X POST \\
                      -H "Content-Type: application/json" \\
                      -d "{
                        \\"oldrev\\": \\"\${oldrev}\\",
                        \\"newrev\\": \\"\${newrev}\\",
                        \\"refname\\": \\"\${refname}\\",
                        \\"branch\\": \\"\${branch}\\",
                        \\"repository\\": \\"$(basename $(pwd))\\"
                      }" \\
                      "\${POST_RECIEVE_HOOK_URL}" >> /dev/null
                done
            `
        )
    });
}

export async function handleGitRequest(event, git_project_root) {
    const { url, request } = event;
    const gitPath = url.pathname.substring(5); // Remove '/git/' prefix

    // Basic security check - prevent directory traversal
    if (gitPath.includes('..') || gitPath.includes('//')) {
        return new Response('Bad Request', { status: 400 });
    }

    return new Promise((resolvePromise) => {
        const pathname = url.pathname;
        const query = url.searchParams;

        // Environment variables for git-http-backend
        const env = {
            ...process.env,
            GIT_PROJECT_ROOT: git_project_root,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: pathname.substring(4), // Remove '/git' prefix
            REQUEST_METHOD: request.method,
            QUERY_STRING: query.toString(),
            CONTENT_TYPE: request.headers.get('content-type') || '',
            CONTENT_LENGTH: request.headers.get('content-length') || '0',
            HTTP_USER_AGENT: request.headers.get('user-agent') || '',
            HTTP_AUTHORIZATION: request.headers.get('authorization') || '',
            REMOTE_ADDR: event.getClientAddress(),
            REMOTE_USER: '',
            SERVER_NAME: url.hostname || 'localhost',
            SERVER_PORT: url.port.toString(),
            POST_RECIEVE_HOOK_URL: `http://${url.hostname}:${url.port}/post_recieve_hook_url/`
        };

        console.log(`http://${url.hostname}:${url.port}/post_recieve_hook_url/`);
        // Spawn git-http-backend process
        const gitBackend = spawn('git', ['http-backend'], {
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Handle errors
        gitBackend.on('error', (error) => {
            console.error('Git backend error:', error);
            resolvePromise(new Response('Internal Server Error', { status: 500 }));
        });

        // Pipe request body to git-http-backend stdin
        if (request.body) {
            const reader = request.body.getReader();
            const pump = async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            gitBackend.stdin.end();
                            break;
                        }
                        gitBackend.stdin.write(value);
                    }
                } catch (error) {
                    console.error('Error piping request body:', error);
                    gitBackend.stdin.end();
                }
            };
            pump();
        } else {
            gitBackend.stdin.end();
        }

        // Handle git-http-backend output
        let responseHeaders = {};
        let headersParsed = false;
        let responseBuffer = Buffer.alloc(0);
        let statusCode = 200;
        const bodyChunks = [];

        gitBackend.stdout.on('data', (chunk) => {
            if (!headersParsed) {
                responseBuffer = Buffer.concat([responseBuffer, chunk]);
                const headerEndIndex = responseBuffer.indexOf('\r\n\r\n');

                if (headerEndIndex !== -1) {
                    // Parse headers
                    const headerSection = responseBuffer.subarray(0, headerEndIndex).toString();
                    const bodySection = responseBuffer.subarray(headerEndIndex + 4);

                    const headers = headerSection.split('\r\n');
                    headers.forEach(header => {
                        const [key, ...valueParts] = header.split(':');
                        if (key && valueParts.length > 0) {
                            const value = valueParts.join(':').trim();
                            if (key.toLowerCase() === 'status') {
                                statusCode = parseInt(value.split(' ')[0]);
                            } else {
                                responseHeaders[key] = value;
                            }
                        }
                    });

                    headersParsed = true;

                    // Add body chunk if exists
                    if (bodySection.length > 0) {
                        bodyChunks.push(bodySection);
                    }
                }
            } else {
                // Headers already parsed, add chunk directly
                bodyChunks.push(chunk);
            }
        });

        gitBackend.stdout.on('end', () => {
            const responseBody = Buffer.concat(bodyChunks);
            resolvePromise(new Response(responseBody, {
                status: statusCode,
                headers: responseHeaders
            }));
        });

        gitBackend.stderr.on('data', (data) => {
            console.error('Git backend stderr:', data.toString());
        });
    });
}
