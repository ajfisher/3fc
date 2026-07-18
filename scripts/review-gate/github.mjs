const API_VERSION = "2022-11-28";

export class GitHubClient {
  constructor({ token, repository, fetchImpl = fetch }) {
    if (!token) {
      throw new Error("GITHUB_TOKEN is required");
    }
    const [owner, repo, extra] = repository.split("/");
    if (!owner || !repo || extra) {
      throw new Error("GITHUB_REPOSITORY must use owner/repository format");
    }
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body, accept = "application/vnd.github+json" } = {}) {
    const response = await this.fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": "3fc-review-gate",
        "x-github-api-version": API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`GitHub API ${method} ${path} failed (${response.status}): ${detail.slice(0, 1000)}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  async paginate(path, key = null) {
    const results = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request(`${path}${separator}per_page=100&page=${page}`);
      const items = key ? response[key] : response;
      results.push(...items);
      if (items.length < 100) {
        break;
      }
    }
    return results;
  }

  async listOpenPullRequestNumbers() {
    const pulls = await this.paginate(`/repos/${this.owner}/${this.repo}/pulls?state=open`);
    return pulls.map((pullRequest) => pullRequest.number);
  }

  getPullRequest(number) {
    return this.request(`/repos/${this.owner}/${this.repo}/pulls/${number}`);
  }

  async getChangedFiles(number) {
    const files = await this.paginate(`/repos/${this.owner}/${this.repo}/pulls/${number}/files`);
    return files.map((file) => file.filename);
  }

  async getCheckRuns(headSha) {
    return this.paginate(
      `/repos/${this.owner}/${this.repo}/commits/${headSha}/check-runs?filter=latest`,
      "check_runs",
    );
  }

  getReviews(number) {
    return this.paginate(`/repos/${this.owner}/${this.repo}/pulls/${number}/reviews`);
  }

  async getCodexActivity(number) {
    const [issueComments, reviewComments] = await Promise.all([
      this.paginate(`/repos/${this.owner}/${this.repo}/issues/${number}/comments`),
      this.paginate(`/repos/${this.owner}/${this.repo}/pulls/${number}/comments`),
    ]);
    return [...issueComments, ...reviewComments];
  }

  async graphql(query, variables) {
    const payload = await this.request("/graphql", {
      method: "POST",
      body: { query, variables },
    });
    if (payload.errors?.length) {
      throw new Error(
        `GitHub GraphQL failed: ${payload.errors.map((error) => error.message).join("; ")}`,
      );
    }
    return payload;
  }

  async getAssociatedPullRequestNumbers(headSha) {
    const pulls = await this.paginate(
      `/repos/${this.owner}/${this.repo}/commits/${headSha}/pulls`,
    );
    return pulls
      .filter((pullRequest) => pullRequest.state === "open")
      .map((pullRequest) => pullRequest.number);
  }

  async getReviewThreads(number) {
    const query = `
      query ReviewGateThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              nodes {
                isResolved
                comments(first: 100) {
                  nodes {
                    isOutdated
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `;
    const threads = [];
    let cursor = null;
    do {
      const response = await this.graphql(query, {
        owner: this.owner,
        repo: this.repo,
        number,
        cursor,
      });
      const connection = response.data?.repository?.pullRequest?.reviewThreads;
      if (!connection) {
        throw new Error(`GitHub GraphQL response did not contain review threads for PR #${number}`);
      }
      for (const thread of connection.nodes) {
        const comments = thread.comments?.nodes ?? [];
        threads.push({
          isResolved: thread.isResolved,
          isOutdated: comments.length > 0 && comments.every((comment) => comment.isOutdated),
        });
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return threads;
  }

  async ensureLabels(definitions) {
    const existing = new Set(
      (await this.paginate(`/repos/${this.owner}/${this.repo}/labels`)).map((label) => label.name),
    );
    for (const definition of definitions) {
      if (existing.has(definition.name)) {
        continue;
      }
      await this.request(`/repos/${this.owner}/${this.repo}/labels`, {
        method: "POST",
        body: definition,
      });
    }
  }

  async addLabels(number, labels) {
    if (labels.length === 0) {
      return;
    }
    await this.request(`/repos/${this.owner}/${this.repo}/issues/${number}/labels`, {
      method: "POST",
      body: { labels },
    });
  }

  async removeLabels(number, labels) {
    for (const label of labels) {
      try {
        await this.request(
          `/repos/${this.owner}/${this.repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
          { method: "DELETE" },
        );
      } catch (error) {
        if (error.status !== 404) {
          throw error;
        }
      }
    }
  }

  async publishCheck({
    headSha,
    state,
    conclusion,
    summary,
    pullRequestNumber,
    pullRequestUrl,
  }) {
    const checkRuns = await this.getCheckRuns(headSha);
    const existing = checkRuns
      .filter((check) => check.name === "review-gate")
      .sort((left, right) => (right.started_at ?? "").localeCompare(left.started_at ?? ""))[0];
    const output = {
      title: `Review gate: ${state.toUpperCase()}`,
      summary: summary.slice(0, 65000),
    };
    const body = conclusion
      ? {
          name: "review-gate",
          head_sha: headSha,
          status: "completed",
          conclusion,
          completed_at: new Date().toISOString(),
          external_id: `review-gate-pr-${pullRequestNumber}`,
          details_url: pullRequestUrl,
          output,
        }
      : {
          name: "review-gate",
          head_sha: headSha,
          status: "in_progress",
          external_id: `review-gate-pr-${pullRequestNumber}`,
          details_url: pullRequestUrl,
          output,
        };

    if (existing) {
      const { head_sha: _headSha, ...updateBody } = body;
      return this.request(
        `/repos/${this.owner}/${this.repo}/check-runs/${existing.id}`,
        { method: "PATCH", body: updateBody },
      );
    }
    return this.request(`/repos/${this.owner}/${this.repo}/check-runs`, {
      method: "POST",
      body,
    });
  }
}
