import OpenAI from "openai";
import { OpenAIStream, StreamingTextResponse } from "ai";
import { Span, initLogger, wrapOpenAI } from "braintrust";
import { Octokit } from "@octokit/rest";
import { GetResponseTypeFromEndpointMethod } from "@octokit/types";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";

// Optional, but recommended: run on the edge runtime.
// See https://vercel.com/docs/concepts/functions/edge-functions
export const runtime = "edge";

const logger = initLogger({
  projectName: "Release notes prod",
  apiKey: process.env.BRAINTRUST_API_KEY,
});

const openai = wrapOpenAI(
  new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
  })
);

type CommitsResponse = GetResponseTypeFromEndpointMethod<
  typeof octokit.rest.repos.listCommits
>;
type Commit = CommitsResponse["data"][number];

// Octokit.js
// https://github.com/octokit/core.js#readme
const octokit: Octokit = new Octokit({
  auth: process.env.GITHUB_ACCESS_TOKEN!,
});

interface CommitInfo {
  url: string;
  html_url: string;
  sha: string;
  commit: {
    author: {
      name?: string;
      email?: string;
      date?: string;
    } | null;
    message: string;
  };
}

async function getCommits(
  span: Span,
  startDate: string,
  endDate: string
): Promise<CommitInfo[]> {
  span.log({
    input: {
      startDate,
      endDate,
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
    },
  });
  const commits: CommitsResponse = await octokit.rest.repos.listCommits({
    owner: process.env.REPO_OWNER!,
    repo: process.env.REPO_NAME!,
    since: startDate,
    until: endDate,
    per_page: 1000,
  });

  const processedCommits = commits.data.map((commit: Commit) => ({
    sha: commit.sha,
    url: commit.url,
    html_url: commit.html_url,
    commit: {
      author: commit.commit.author,
      message: commit.commit.message,
    },
  }));

  span.log({
    output: processedCommits,
  });
  return processedCommits;
}

function serializeCommit(info: CommitInfo): string {
  return `SHA: ${info.sha}
DATE: ${info.commit.author?.date}
MESSAGE: ${info.commit.message.substring(0, 2048)}`;
}

function generatePrompt(commits: CommitInfo[]): ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: `You are an expert technical writer who generates release notes for the Braintrust SDK.
You will be provided a list of commits, including their message, author, and date, and you will generate
a full list of release notes, in markdown list format, across the commits. You should make sure to include
some information about each commit, without the commit sha, url, or author info. However, do not mention
version bumps multiple times. If there are multiple version bumps, only mention the latest one.`,
    },
    {
      role: "user",
      content:
        "Commits: \n" + commits.map((c) => serializeCommit(c)).join("\n\n"),
    },
  ];
}

function flattenChunks(allChunks: Uint8Array[]) {
  const flatArray = new Uint8Array(allChunks.reduce((a, b) => a + b.length, 0));
  for (let i = 0, offset = 0; i < allChunks.length; i++) {
    flatArray.set(allChunks[i], offset);
    offset += allChunks[i].length;
  }
  return new TextDecoder().decode(flatArray);
}

export async function POST(req: Request) {
  const { startDate, endDate } = await req.json();
  const stream = await logger.traced(
    async (span) => {
      console.log("startDate", startDate);
      console.log("endDate", endDate);

      const commits = await span.traced(
        (span) => getCommits(span, startDate, endDate),
        {
          name: "get-commits",
        }
      );

      // Request the OpenAI API for the response based on the prompt
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo-0125",
        stream: true,
        messages: generatePrompt(commits),
      });

      // Convert the response into a friendly text-stream
      const stream = OpenAIStream(response);

      const allChunks: Uint8Array[] = [];
      const outputStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          allChunks.push(chunk);
          controller.enqueue(chunk);
        },
        async flush(controller) {
          const text = flattenChunks(allChunks);
          span.log({ output: text });
        },
      });

      return stream.pipeThrough(outputStream);
    },
    {
      name: "generate-release-notes",
      event: {
        input: {
          startDate,
          endDate,
        },
      },
    }
  );

  // Respond with the stream
  return new StreamingTextResponse(stream);
}
