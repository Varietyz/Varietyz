import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LOGIN = "Varietyz";
const OUTPUT = process.argv[2] ?? "assets/stats.svg";
const TOKEN = process.env.STATS_TOKEN;
const TOP_LANGUAGES = 6;
const MIN_SHARE = 0.005;
const HIDDEN_LANGUAGES = new Set(["HTML"]);
const LOOP_START = 2.8;
const TRAVEL_SECONDS = 7;
const SHIMMER_SECONDS = 4;
const SHIMMER_WIDTH = 60;
const BREATH_SECONDS = 6;

const PALETTE = {
    accent: "#cea555",
    accentSoft: "rgba(206,165,85,0.35)",
    ground: "#1f1f1f",
    groundDeep: "#171717",
    liquid: "#61afd8",
    muted: "#888888",
    other: "#4a4f57",
    text: "#cccccc",
};

const FONT = "'JetBrains Mono','Source Code Pro',ui-monospace,SFMono-Regular,Consolas,monospace";

const USER_QUERY = `query ($login: String!, $pullRequests: String!) {
  pullRequests: search(query: $pullRequests, type: ISSUE, first: 1) { issueCount }
  user(login: $login) {
    id
    followers { totalCount }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount } }
      }
    }
  }
}`;

const REPOSITORY_QUERY = `query ($after: String, $author: ID!) {
  viewer {
    login
    repositories(ownerAffiliations: [OWNER, ORGANIZATION_MEMBER], affiliations: [OWNER, ORGANIZATION_MEMBER], isFork: false, first: 50, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        isPrivate
        stargazerCount
        defaultBranchRef {
          target {
            ... on Commit { history(author: { id: $author }) { totalCount } }
          }
        }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

const graphql = async function graphql(query, variables) {
    const response = await fetch("https://api.github.com/graphql", {
        body: JSON.stringify({ query, variables }),
        headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
        method: "POST",
    });
    const payload = await response.json();
    if (!response.ok || payload.errors) {
        throw new Error(`The GitHub API refused the stats query: ${JSON.stringify(payload.errors ?? payload)}`);
    }
    return payload.data;
};

const repositoriesOf = async function repositoriesOf(author) {
    const nodes = [];
    let after = null;
    let total = 0;
    do {
        const { viewer } = await graphql(REPOSITORY_QUERY, { after, author });
        if (viewer.login !== LOGIN) {
            throw new Error(`STATS_TOKEN belongs to ${viewer.login}, not ${LOGIN}, so it cannot read ${LOGIN}'s private repositories. Use a token created by ${LOGIN}.`);
        }
        nodes.push(...viewer.repositories.nodes);
        total = viewer.repositories.totalCount;
        after = viewer.repositories.pageInfo.hasNextPage ? viewer.repositories.pageInfo.endCursor : null;
    } while (after);
    if (nodes.length !== total) {
        throw new Error(`The API reported ${total} repositories but returned ${nodes.length}, so the card would undercount. Run the workflow again.`);
    }
    return nodes;
};

const fetchUser = async function fetchUser() {
    if (!TOKEN) {
        throw new Error("STATS_TOKEN is not set, so private repositories cannot be read. Add a token with read access to all your repositories as the STATS_TOKEN secret.");
    }
    const { pullRequests, user } = await graphql(USER_QUERY, { login: LOGIN, pullRequests: `is:pr author:${LOGIN}` });
    return { ...user, pullRequests: pullRequests.issueCount, repositories: await repositoriesOf(user.id) };
};

const escaped = function escaped(text) {
    return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
};

const grouped = function grouped(value) {
    return new Intl.NumberFormat("en-US").format(value);
};

const languagesOf = function languagesOf(repositories) {
    const totals = new Map();
    for (const repository of repositories) {
        for (const edge of repository.languages.edges.filter((entry) => !HIDDEN_LANGUAGES.has(entry.node.name))) {
            const current = totals.get(edge.node.name) ?? { color: edge.node.color ?? PALETTE.other, size: 0 };
            current.size += edge.size;
            totals.set(edge.node.name, current);
        }
    }
    const ranked = [...totals.entries()]
        .map(([name, value]) => ({ color: value.color, name, size: value.size }))
        .toSorted((left, right) => right.size - left.size);
    const total = ranked.reduce((sum, entry) => sum + entry.size, 0);
    const visible = ranked.filter((entry, index) => index < TOP_LANGUAGES && entry.size / total >= MIN_SHARE);
    const top = visible.slice();
    const rest = total - visible.reduce((sum, entry) => sum + entry.size, 0);
    if (total > 0 && rest / total >= MIN_SHARE) {
        top.push({ color: PALETTE.other, name: "Other", size: rest });
    }
    const shown = top.reduce((sum, entry) => sum + entry.size, 0);
    return top.map((entry) => ({ ...entry, share: shown === 0 ? 0 : entry.size / shown }));
};

const weeklyTotals = function weeklyTotals(calendar) {
    return calendar.weeks.map((week) => week.contributionDays.reduce((sum, day) => sum + day.contributionCount, 0));
};

const rise = function rise(delay, role = "") {
    return `class="${`${role} rise`.trim()}" style="animation-delay:${delay.toFixed(2)}s"`;
};

const metricsBlock = function metricsBlock(metrics) {
    const columns = [32, 216, 382];
    const rows = [104, 170];
    return metrics
        .map((metric, index) => {
            const x = columns[index % columns.length];
            const y = rows[Math.floor(index / columns.length)];
            return `<g ${rise(0.15 + index * 0.08)}>
    <text x="${x}" y="${y}" class="value">${escaped(grouped(metric.value))}</text>
    <text x="${x}" y="${y + 20}" class="label">${escaped(metric.label)}</text>
  </g>`;
        })
        .join("\n  ");
};

const languageBlock = function languageBlock(languages) {
    const left = 572;
    const width = 236;
    let offset = left;
    const bars = languages
        .map((language, index) => {
            const size = Math.max(language.share * width, 1);
            const bar = `<rect x="${offset.toFixed(2)}" y="90" height="10" width="0" fill="${escaped(language.color)}">
    <animate attributeName="width" from="0" to="${size.toFixed(2)}" begin="${(0.5 + index * 0.12).toFixed(2)}s" dur="0.6s" fill="freeze" calcMode="spline" keySplines="0.25 0.46 0.45 0.94" keyTimes="0;1"/>
  </rect>`;
            offset += size;
            return bar;
        })
        .join("\n  ");
    const legend = languages
        .map((language, index) => {
            const y = 128 + index * 19;
            return `<g ${rise(0.6 + index * 0.08)}>
    <circle cx="${left + 5}" cy="${y - 4}" r="4" fill="${escaped(language.color)}"/>
    <text x="${left + 16}" y="${y}" class="legend">${escaped(language.name)}</text>
    <text x="${left + width}" y="${y}" class="legend share" text-anchor="end">${(language.share * 100).toFixed(1)}%</text>
  </g>`;
        })
        .join("\n  ");
    const shimmer = `<g clip-path="url(#bar)" class="loop">
    <rect x="${left - SHIMMER_WIDTH}" y="90" width="${SHIMMER_WIDTH}" height="10" fill="url(#shimmer)" opacity="0">
      <set attributeName="opacity" to="1" begin="${LOOP_START}s"/>
      <animate attributeName="x" values="${left - SHIMMER_WIDTH};${left + width};${left + width}" keyTimes="0;0.55;1" dur="${SHIMMER_SECONDS}s" begin="${LOOP_START}s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0 0 1 1"/>
    </rect>
  </g>`;
    return `<text x="${left}" y="72" ${rise(0.4, "heading")}>Languages by code size</text>
  <clipPath id="bar"><rect x="${left}" y="90" width="${width}" height="10" rx="2"/></clipPath>
  <rect x="${left}" y="90" width="${width}" height="10" rx="2" fill="${PALETTE.groundDeep}"/>
  ${bars}
  ${shimmer}
  ${legend}`;
};

const sparklineBlock = function sparklineBlock(weeks, top) {
    const left = 32;
    const right = 808;
    const bottom = 324;
    const height = 44;
    const peak = Math.max(...weeks, 1);
    const step = (right - left) / Math.max(weeks.length - 1, 1);
    const points = weeks.map((count, index) => [left + index * step, bottom - (count / peak) * height]);
    const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const area = `${line} L${right},${bottom} L${left},${bottom} Z`;
    const average = weeks.reduce((sum, count) => sum + count, 0) / Math.max(weeks.length, 1);
    const caption = `<text x="${left}" y="${top}" ${rise(0.9, "legend")}><tspan class="heading">Contributions per week:</tspan><tspan class="share" dx="8">Peak</tspan><tspan class="minor" dx="6">${escaped(grouped(Math.max(...weeks, 0)))}</tspan><tspan class="share">,</tspan><tspan class="share" dx="8">Average</tspan><tspan class="minor" dx="6">${escaped(grouped(Math.round(average)))}</tspan></text>`;
    return `${caption}
  <path d="${area}" fill="url(#area)" ${rise(1.4)}/>
  <path d="${line}" fill="none" stroke="${PALETTE.accent}" stroke-width="1.6" stroke-linejoin="round" pathLength="1" class="draw"/>
  <g class="loop" opacity="0">
    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.06;0.94;1" dur="${TRAVEL_SECONDS}s" begin="${LOOP_START}s" repeatCount="indefinite"/>
    <circle r="7" fill="url(#spark)"/>
    <circle r="2.4" fill="#fff4dc"/>
    <animateMotion path="${line}" dur="${TRAVEL_SECONDS}s" begin="${LOOP_START}s" repeatCount="indefinite" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.45 0 0.55 1"/>
  </g>`;
};

const render = function render(user) {
    const collection = user.contributionsCollection;
    const repositories = user.repositories;
    const stars = repositories.reduce((sum, repository) => sum + repository.stargazerCount, 0);
    const commits = repositories.reduce((sum, repository) => sum + (repository.defaultBranchRef?.target?.history?.totalCount ?? 0), 0);
    const metrics = [
        { label: "Contributions, last year", value: collection.contributionCalendar.totalContributions },
        { label: "Commits", value: commits },
        { label: "Pull requests", value: user.pullRequests },
        { label: "Stars", value: stars },
        { label: "Repositories", value: repositories.length },
        { label: "Followers", value: user.followers.totalCount },
    ];
    const updated = new Date().toISOString().slice(0, 10);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="354" viewBox="0 0 840 354" role="img" aria-labelledby="title">
  <title id="title">GitHub activity of ${LOGIN}</title>
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PALETTE.ground}"/>
      <stop offset="1" stop-color="${PALETTE.groundDeep}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0" r="0.6">
      <stop offset="0" stop-color="${PALETTE.accent}" stop-opacity="0.14">
        <animate attributeName="stop-opacity" values="0.14;0.22;0.14" dur="${BREATH_SECONDS}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>
      </stop>
      <stop offset="1" stop-color="${PALETTE.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="spark">
      <stop offset="0" stop-color="${PALETTE.accent}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${PALETTE.accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shimmer" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PALETTE.accent}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${PALETTE.accent}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: ${FONT}; }
    .title { fill: ${PALETTE.accent}; font-size: 17px; font-weight: 700; letter-spacing: 0.05em; }
    .heading { fill: ${PALETTE.accent}; font-size: 12px; font-weight: 600; letter-spacing: 0.05em; }
    .value { fill: #ffffff; font-size: 26px; font-weight: 700; }
    .label { fill: ${PALETTE.muted}; font-size: 12px; }
    .legend { fill: ${PALETTE.text}; font-size: 12px; }
    .share { fill: ${PALETTE.muted}; }
    .minor { fill: #ffffff; font-weight: 700; }
    .stamp { fill: ${PALETTE.muted}; font-size: 10px; }
    .rise { opacity: 0; animation: rise 0.6s cubic-bezier(0.25,0.46,0.45,0.94) forwards; }
    .draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 1.8s cubic-bezier(0.25,0.46,0.45,0.94) 1s forwards; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    @media (prefers-reduced-motion: reduce) {
      .rise { animation: none; opacity: 1; }
      .draw { animation: none; stroke-dashoffset: 0; }
      .loop { display: none; }
    }
  </style>
  <rect x="0.5" y="0.5" width="839" height="353" rx="10" fill="url(#ground)" stroke="${PALETTE.accentSoft}"/>
  <rect x="0.5" y="0.5" width="839" height="353" rx="10" fill="url(#glow)"/>
  <text x="32" y="44" ${rise(0, "title")}>GitHub activity</text>
  ${metricsBlock(metrics)}
  ${languageBlock(languagesOf(repositories))}
  ${sparklineBlock(weeklyTotals(collection.contributionCalendar), 258)}
  <text x="808" y="44" text-anchor="end" ${rise(0.2, "stamp")}>Updated ${updated}</text>
</svg>
`;
};

const user = await fetchUser();
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, render(user));
console.log(`Wrote ${OUTPUT}.`);
