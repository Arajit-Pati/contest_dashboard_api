const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

let DEFAULT_PROBLEMS = [
  { problemName: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/', points: 100 },
  { problemName: 'Longest Substring Without Repeating Characters', url: 'https://leetcode.com/problems/longest-substring-without-repeating-characters/', points: 150 },
  { problemName: 'Median of Two Sorted Arrays', url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/', points: 200 },
];

let CONTEST_START = new Date(process.env.CONTEST_START || '2026-07-03T14:40:00+05:30').getTime();
let CONTEST_END = new Date(process.env.CONTEST_END || '2026-07-03T15:43:00+05:30').getTime();

function parseProblemLine(line) {
  const re = /problemName\s*:\s*(['"])(.*?)\1\s*;\s*url\s*:\s*(['"])(.*?)\3\s*;\s*points\s*:\s*(\d+)/i;
  const m = line.match(re);
  if (!m) return null;
  let problemName = m[2].trim();
  let rawUrl = m[4].trim();
  // support markdown-style [text](url)
  const mdMatch = rawUrl.match(/\[.*?\]\((.*?)\)/);
  const url = mdMatch ? mdMatch[1] : rawUrl;
  const points = Number.parseInt(m[5], 10) || 0;
  return { problemName, url, points };
}

function loadProblemsFromFile() {
  const filePath = path.join(__dirname, 'problems.txt');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const problems = [];
    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#') || line.startsWith('//')) continue;
      const parsed = parseProblemLine(line);
      if (parsed) problems.push(parsed);
    }
    if (problems.length > 0) {
      DEFAULT_PROBLEMS = problems.map((p) => ({ problemName: p.problemName, url: p.url, points: p.points }));
      console.log(`Loaded ${DEFAULT_PROBLEMS.length} problems from problems.txt`);
      return;
    }
    console.warn('problems.txt found but contains no valid problem entries. Falling back to internal defaults.');
  } catch (err) {
    console.warn('Could not read problems.txt, falling back to internal defaults. Error:', err.message);
  }
}

function loadContestTimings() {
  const filePath = path.join(__dirname, 'timings.txt');
  try{
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));
    
    const startString = lines[0].replace(/['"]/g, '');
    const endString = lines[1].replace(/['"]/g, '');

    CONTEST_START = new Date(startString).getTime();
    CONTEST_END = new Date(endString).getTime();

    console.log(`Loaded contest timings.`);
  }
  catch(err){
    console.error("Failure loading contest timings from file:", err.message);
  }
}

loadProblemsFromFile();
loadContestTimings();

const users = {};
const pendingTokens = {}; // map token -> { username, problemName, expiresAt }

function generateToken() {
  // 24 hex chars (~12 bytes) is compact and reasonably unpredictable for this use
  return crypto.randomBytes(12).toString('hex');
}

function cleanupExpiredTokens() {
  const nowTs = Date.now();
  for (const t of Object.keys(pendingTokens)) {
    if (pendingTokens[t].expiresAt <= nowTs) {
      delete pendingTokens[t];
    }
  }
}

// Periodically clean expired tokens to avoid memory growth
setInterval(cleanupExpiredTokens, 5 * 1000);

function now() {
  return Date.now();
}

function contestHasEnded() {
  return now() >= CONTEST_END;
}

function contestIsActive() {
  const current = now();
  return current >= CONTEST_START && current < CONTEST_END;
}

function formatProblemList(inputProblems) {
  const source = Array.isArray(inputProblems) && inputProblems.length > 0 ? inputProblems : DEFAULT_PROBLEMS;

  return source.map((item, index) => {
    const problemName = typeof item === 'string' ? item : item.problemName || `Problem ${index + 1}`;
    const url = typeof item === 'string'
      ? `https://leetcode.com/problems/${problemName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/`
      : item.url || `https://leetcode.com/problems/${problemName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/`;

    return {
      problemName,
      url,
      status: 'unsolved',
      locked: false,
      lastRecordedStatus: null,
      totalTimeSpent: 0,
      timeSpent: 0,
      activeSince: null,
      points: Number.isFinite(item?.points) ? item.points : 0,
      correctTestCases: 0,
      totalTestCases: 0,
    };
  });
}

// A flag to ensure we only run the cleanup once
let hasContestFinalized = false;

function finalizeAllActiveSessions() {
  if (hasContestFinalized) return;
  hasContestFinalized = true;

  console.log("Contest Ended! Running automated cleanup for active sessions...");

  Object.values(users).forEach(user => {
    if (!user.problems) return;

    user.problems.forEach(problem => {
      finalizeProblemState(problem, problem.lastRecordedStatus);
    });
  });
}

function getActiveProblem(user) {
  return user.problems.find((problem) => problem.status === 'active') || null;
}

function elapsedMillisecondsSince(activeSince) {
  if (!activeSince) {
    return 0;
  }

  return Math.max(0, now() - activeSince);
}

function liveTotalTimeSpent(user) {
  const activeProblem = getActiveProblem(user);
  const currentActiveMilliseconds = activeProblem && activeProblem.activeSince ? elapsedMillisecondsSince(activeProblem.activeSince) : 0;
  const accumulatedMilliseconds = user.problems.reduce((total, problem) => total + (Number.isFinite(problem.totalTimeSpent) ? problem.totalTimeSpent : 0), 0);

  return accumulatedMilliseconds + currentActiveMilliseconds;
}

function isAcceptedStatus(status) {
  return typeof status === 'string' && status.trim() === 'Accepted';
}

function hasMeaningfulPartialStatus(status) {
  if (typeof status !== 'string') {
    return false;
  }

  const normalized = status.trim();
  return Boolean(normalized) && /\d+\s*\/\s*\d+/.test(normalized);
}

function isPartialStatus(status) {
  return typeof status === 'string' && status.trim().toLowerCase().startsWith('partial:') && hasMeaningfulPartialStatus(status);
}

function isTrueSolvedProblem(problem) {
  return Boolean(problem && problem.lastRecordedStatus === 'Accepted' && (problem.status === 'Solved' || problem.status === 'solved'));
}

function getReadableProblemStatus(problem) {
  if (!problem) {
    return 'Unsolved';
  }

  if (problem.status === 'Solved' || problem.status === 'solved') {
    return 'Solved';
  }

  if (typeof problem.status === 'string' && problem.status.startsWith('Partial Attempt')) {
    return problem.status;
  }

  if (typeof problem.status === 'string' && problem.status.startsWith('Partial Lockout')) {
    return problem.status;
  }

  if (hasMeaningfulPartialStatus(problem.status)) {
    const suffix = String(problem.status).replace(/^partial:/i, '').trim();
    return suffix ? `Partial Attempt: ${suffix}` : 'Partial Attempt';
  }

  return problem.status || 'Unsolved';
}

function parseTestCaseSummary(rawStatus, fallback = {}) {
  const statusText = typeof rawStatus === 'string' ? rawStatus.trim() : '';
  const slashMatch = statusText.match(/(\d+)\s*\/\s*(\d+)/);
  const fallbackCorrect = Number.isFinite(fallback.correctTestCases) ? fallback.correctTestCases : 0;
  const fallbackTotal = Number.isFinite(fallback.totalTestCases) ? fallback.totalTestCases : 0;

  if (slashMatch) {
    const correct = Number.parseInt(slashMatch[1], 10);
    const total = Number.parseInt(slashMatch[2], 10);
    return {
      correctTestCases: Number.isFinite(correct) ? correct : fallbackCorrect,
      totalTestCases: Number.isFinite(total) ? total : fallbackTotal,
    };
  }

  if (/accepted/i.test(statusText)) {
    return {
      correctTestCases: fallbackCorrect || 0,
      totalTestCases: fallbackTotal || 0,
    };
  }

  return {
    correctTestCases: fallbackCorrect,
    totalTestCases: fallbackTotal,
  };
}

function normalizeProblemTiming(problem) {
  const spentMilliseconds = Number.isFinite(problem?.totalTimeSpent) ? problem.totalTimeSpent : 0;
  const spentSeconds = Math.max(0, Math.floor(spentMilliseconds / 1000));
  return {
    totalTimeSpent: spentSeconds,
    timeSpent: spentSeconds,
  };
}

function serializeUser(user) {
  return {
    username: user.username,
    totalTimeSpent: Math.round(liveTotalTimeSpent(user) / 1000),
    solvedCount: user.problems.filter((problem) => isTrueSolvedProblem(problem)).length,
    activeProblem: getActiveProblem(user)?.problemName || null,
    partialProgress: user.problems
      .filter((problem) => hasMeaningfulPartialStatus(problem.lastRecordedStatus || problem.status))
      .map((problem) => ({ problemName: problem.problemName, status: getReadableProblemStatus(problem) })),
    problems: user.problems.map((problem) => {
      const timing = normalizeProblemTiming(problem);
      return {
        problemName: problem.problemName,
        url: problem.url,
        status: getReadableProblemStatus(problem),
        totalTimeSpent: timing.totalTimeSpent,
        timeSpent: timing.timeSpent,
        points: Number.isFinite(problem.points) ? problem.points : 0,
        locked: Boolean(problem.locked),
        activeSince: problem.activeSince,
        elapsedSeconds: problem.status === 'active' && problem.activeSince ? Math.floor(elapsedMillisecondsSince(problem.activeSince) / 1000) : 0,
        lastRecordedStatus: problem.lastRecordedStatus || null,
        correctTestCases: Number.isFinite(problem.correctTestCases) ? problem.correctTestCases : 0,
        totalTestCases: Number.isFinite(problem.totalTestCases) ? problem.totalTestCases : 0,
      };
    }),
  };
}

function ensureUserRecord(username) {
  const normalizedProblems = formatProblemList(DEFAULT_PROBLEMS);

  if (!users[username]) {
    users[username] = {
      username,
      problems: normalizedProblems,
    };
    return users[username];
  }

  const existingMap = new Map(users[username].problems.map((problem) => [problem.problemName, problem]));

  users[username].problems = normalizedProblems.map((problem) => {
    const existing = existingMap.get(problem.problemName);
    if (!existing) {
      return problem;
    }
    
    return existing;
  });

  return users[username];
}

function finalizeProblemState(problem, recordedStatus, testCaseSummary = {}) {
  if (!problem) {
    return { finalStatus: 'Partial Attempt', awardedPoints: 0 };
  }

  if (problem.activeSince) {
    problem.totalTimeSpent += elapsedMillisecondsSince(problem.activeSince);
    problem.activeSince = null;
  }

  const normalizedRecordedStatus = typeof recordedStatus === 'string' ? recordedStatus.trim() : '';
  const parsedSummary = parseTestCaseSummary(normalizedRecordedStatus, testCaseSummary);
  problem.correctTestCases = Number.isFinite(parsedSummary.correctTestCases) ? parsedSummary.correctTestCases : 0;
  problem.totalTestCases = Number.isFinite(parsedSummary.totalTestCases) ? parsedSummary.totalTestCases : 0;
  problem.timeSpent = Math.max(0, Math.floor(problem.totalTimeSpent / 1000));

  if (isAcceptedStatus(normalizedRecordedStatus)) {
    problem.status = 'Solved';
    problem.locked = true;
    problem.awardedPoints = Number.isFinite(problem.points) ? problem.points : 0;
    problem.lastRecordedStatus = 'Accepted';
    return { finalStatus: 'Solved', awardedPoints: problem.awardedPoints };
  }

  if (hasMeaningfulPartialStatus(normalizedRecordedStatus)) {
    const suffix = normalizedRecordedStatus.replace(/^partial:/i, '').trim();
    problem.status = suffix ? `Partial Attempt: ${suffix}` : 'Partial Attempt';
    problem.locked = true;
    problem.awardedPoints = 0;
    problem.lastRecordedStatus = normalizedRecordedStatus;
    return { finalStatus: problem.status, awardedPoints: 0 };
  }

  if(problem.status.toLowerCase() === 'unsolved'){
    problem.lastRecordedStatus = 'unsolved';
  }
  else{
    problem.status = 'Partial Attempt';
    problem.lastRecordedStatus = 'Partial Attempt';
  }
  problem.locked = true;
  problem.awardedPoints = 0;
  return { finalStatus: problem.status, awardedPoints: 0 };
}

function normalizeSubmissionStatus(rawStatus) {
  if (typeof rawStatus !== 'string') {
    return '';
  }

  const trimmed = rawStatus.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.toLowerCase() === 'accepted') {
    return 'Accepted';
  }

  const match = rawStatus.match(/(\d+\s*\/\s*\d+)/);
  if (match){
    return `partial: ${match[1]}`;
  }
  
  return '';
}

function resolveSubmissionPayload(body) {
  const statusValue = body?.status ?? (body?.accepted === true ? 'Accepted' : '');
  const normalizedStatus = normalizeSubmissionStatus(statusValue);
  const parsedSummary = parseTestCaseSummary(normalizedStatus, {
    correctTestCases: Number.isFinite(body?.correctTestCases) ? body.correctTestCases : 0,
    totalTestCases: Number.isFinite(body?.totalTestCases) ? body.totalTestCases : 0,
  });

  return {
    username: String(body?.username || '').trim(),
    problemName: String(body?.problem || body?.problemName || '').trim(),
    status: normalizedStatus,
    submissionId: String(body?.submission_id || body?.submissionId || '').trim(),
    testCaseSummary: parsedSummary,
  };
}

function processSubmission(body) {
  const { username, problemName, status, submissionId, testCaseSummary } = resolveSubmissionPayload(body);

  if (!username || !problemName) {
    return { statusCode: 400, payload: { error: 'username and problem are required.' } };
  }

  if (!status) {
    return { statusCode: 400, payload: { error: 'status is required and must be "Accepted" or start with "Partial:".' } };
  }

  const user = users[username];
  if (!user) {
    return { statusCode: 404, payload: { error: 'User is not registered.' } };
  }

  const targetProblem = user.problems.find((problem) => problem.problemName === problemName);
  if (!targetProblem) {
    return { statusCode: 404, payload: { error: 'Problem not found for user.' } };
  }

  if (targetProblem.locked || targetProblem.status === 'solved') {
    return { statusCode: 200, payload: { ok: true, message: 'Problem was already finalized.', user: serializeUser(user) } };
  }

  if (status === 'Accepted') {
    const finalized = finalizeProblemState(targetProblem, status, testCaseSummary);
    targetProblem.lastRecordedStatus = 'Accepted';
    if (submissionId) {
      targetProblem.lastSubmissionId = submissionId;
    }

    return {
      statusCode: 200,
      payload: {
        ok: true,
        finalStatus: finalized.finalStatus,
        awardedPoints: finalized.awardedPoints,
        user: serializeUser(user),
      },
    };
  }

  if (targetProblem.activeSince) {
    targetProblem.totalTimeSpent += elapsedMillisecondsSince(targetProblem.activeSince);
    targetProblem.activeSince = null;
  }

  if (status.toLowerCase().startsWith('partial:')) {
    targetProblem.status = status;
  }

  const parsedSummary = parseTestCaseSummary(status, testCaseSummary);
  targetProblem.correctTestCases = Number.isFinite(parsedSummary.correctTestCases) ? parsedSummary.correctTestCases : 0;
  targetProblem.totalTestCases = Number.isFinite(parsedSummary.totalTestCases) ? parsedSummary.totalTestCases : 0;
  targetProblem.timeSpent = Math.max(0, Math.floor(targetProblem.totalTimeSpent / 1000));
  targetProblem.lastRecordedStatus = status;

  if (submissionId) {
    targetProblem.lastSubmissionId = submissionId;
  }

  return { statusCode: 200, payload: { ok: true, user: serializeUser(user) } };
}

function buildLeaderboardSnapshot() {
  const snapshot = Object.values(users).map((user) => {
    const solvedProblems = user.problems.filter((problem) => isTrueSolvedProblem(problem));
    const partialCount = user.problems.filter((problem) => hasMeaningfulPartialStatus(problem.lastRecordedStatus || problem.status || '')).length;
    const totalPoints = solvedProblems.reduce((sum, problem) => sum + (Number.isFinite(problem.points) ? problem.points : 0), 0);
    const totalCorrectTestCases = user.problems.reduce((sum, problem) => sum + (Number.isFinite(problem.correctTestCases) ? problem.correctTestCases : 0), 0);

    return {
      username: user.username,
      totalPoints,
      solvedCount: solvedProblems.length,
      partialCount,
      partialSolvedCount: partialCount,
      totalTimeSpent: Math.round(liveTotalTimeSpent(user) / 1000),
      totalCorrectTestCases,
      activeProblem: getActiveProblem(user)?.problemName || null,
      problems: user.problems.map((problem) => ({
        problemName: problem.problemName,
        status: getReadableProblemStatus(problem),
        points: Number.isFinite(problem.points) ? problem.points : 0,
        locked: Boolean(problem.locked),
        lastRecordedStatus: problem.lastRecordedStatus || null,
        timeSpent: Number.isFinite(problem.totalTimeSpent) ? Math.floor(problem.totalTimeSpent / 1000) : 0,
        correctTestCases: Number.isFinite(problem.correctTestCases) ? problem.correctTestCases : 0,
        totalTestCases: Number.isFinite(problem.totalTestCases) ? problem.totalTestCases : 0,
      })),
    };
  });

  snapshot.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) {
      return b.totalPoints - a.totalPoints;
    }
    if (b.solvedCount !== a.solvedCount) {
      return b.solvedCount - a.solvedCount;
    }
    if (b.partialCount !== a.partialCount) {
      return b.partialCount - a.partialCount;
    }
    if (a.totalTimeSpent !== b.totalTimeSpent) {
      return a.totalTimeSpent - b.totalTimeSpent;
    }
    if (a.totalCorrectTestCases !== b.totalCorrectTestCases) {
      return b.totalCorrectTestCases - a.totalCorrectTestCases;
    }
    return a.username.localeCompare(b.username);
  });

  return {
    contestStart: CONTEST_START,
    contestEnd: CONTEST_END,
    contestActive: contestIsActive(),
    contestEnded: contestHasEnded(),
    globalProblems: DEFAULT_PROBLEMS.map((problem) => ({
      problemName: problem.problemName,
      url: problem.url,
      points: Number.isFinite(problem.points) ? problem.points : 0,
    })),
    users: snapshot,
  };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/contest/register', (req, res) => {
  if (contestHasEnded()) {
    return res.json({ ignored: true, reason: 'Contest has already ended.' });
  }

  if (!contestIsActive()) {
    return res.json({ ignored: true, reason: 'Contest has not started yet.' });
  }

  const username = String(req.body?.username || '').trim();
  if (!username) {
    return res.status(400).json({ error: 'username is required.' });
  }

  const user = ensureUserRecord(username, req.body?.problems);

  return res.json({
    ok: true,
    username,
    problems: user.problems,
  });
});

app.post('/api/track/switch', (req, res) => {
  if (contestHasEnded()) {
    return res.json({ ignored: true, reason: 'Contest has already ended.' });
  }

  if (!contestIsActive()) {
    return res.json({ ignored: true, reason: 'Contest has not started yet.' });
  }

  const username = String(req.body?.username || '').trim();
  const problemName = String(req.body?.problemName || req.body?.problem || '').trim();

  if (!username || !problemName) {
    return res.status(400).json({ error: 'username and problemName are required.' });
  }

  const user = users[username];
  if (!user) {
    return res.status(404).json({ error: 'User is not registered.' });
  }

  const targetProblem = user.problems.find((problem) => problem.problemName === problemName);
  if (!targetProblem) {
    return res.status(404).json({ error: 'Problem not found for user.' });
  }

  if (targetProblem.locked || targetProblem.status === 'solved') {
    return res.status(409).json({ error: 'This problem is locked and cannot be tracked again.' });
  }

  const nowAtSwitch = now();
  const activeProblem = getActiveProblem(user);

  if (activeProblem && activeProblem.problemName !== problemName) {
    activeProblem.totalTimeSpent += elapsedMillisecondsSince(activeProblem.activeSince);
    activeProblem.status = 'paused';
    activeProblem.activeSince = null;
  }

  if (targetProblem.status !== 'active') {
    targetProblem.status = 'active';
    targetProblem.activeSince = nowAtSwitch;
  }

  // generate a short-lived activation token (10 seconds)
  try {
    const token = generateToken();
    const ttlMs = 10 * 1000;
    pendingTokens[token] = {
      username,
      problemName,
      expiresAt: Date.now() + ttlMs,
    };

    return res.json({ ok: true, token, user: serializeUser(user) });
  } catch (err) {
    // fallback: return without token but still allow switching
    console.error(`Unable to generate token. Error:`, err.message);
    return res.json({ ok: true, user: serializeUser(user) });
  }
});

// Verify token endpoint
app.post('/api/track/verify-token', (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) {
    return res.status(400).json({ valid: false, message: 'token is required.' });
  }

  const entry = pendingTokens[token];
  if (!entry) {
    return res.status(404).json({ valid: false, message: 'token not found or already used/expired.' });
  }

  if (entry.expiresAt < Date.now()) {
    delete pendingTokens[token];
    return res.status(410).json({ valid: false, message: 'token has expired.' });
  }

  // token is valid; consume it
  delete pendingTokens[token];
  return res.status(200).json({ valid: true, message: 'token verified', username: entry.username, problemName: entry.problemName });
});

app.post('/api/track/submission', (req, res) => {
  if (contestHasEnded()) {
    return res.json({ ignored: true, reason: 'Contest has already ended.' });
  }

  if (!contestIsActive()) {
    return res.json({ ignored: true, reason: 'Contest has not started yet.' });
  }

  const result = processSubmission(req.body);
  return res.status(result.statusCode).json(result.payload);
});

app.post('/api/track/accepted', (req, res) => {
  if (contestHasEnded()) {
    return res.json({ ignored: true, reason: 'Contest has already ended.' });
  }

  if (!contestIsActive()) {
    return res.json({ ignored: true, reason: 'Contest has not started yet.' });
  }

  const username = String(req.body?.username || '').trim();
  const problemName = String(req.body?.problemName || req.body?.problem || '').trim();

  if (!username || !problemName) {
    return res.status(400).json({ error: 'username and problemName are required.' });
  }

  const user = users[username];
  if (!user) {
    return res.status(404).json({ error: 'User is not registered.' });
  }

  const targetProblem = user.problems.find((problem) => problem.problemName === problemName);
  if (!targetProblem) {
    return res.status(404).json({ error: 'Problem not found for user.' });
  }

  if (targetProblem.locked) {
    return res.status(200).json({ ok: true, message: 'Problem is already finalized.', user: serializeUser(user) });
  }

  const recordedStatus = targetProblem.lastRecordedStatus; // may be null valued
  const finalized = finalizeProblemState(targetProblem, recordedStatus);

  return res.status(200).json({
    ok: true,
    finalStatus: finalized.finalStatus,
    awardedPoints: finalized.awardedPoints,
    user: serializeUser(user),
  });
});

app.get('/api/leaderboard', (req, res) => {
  return res.json(buildLeaderboardSnapshot());
});

app.get('/api/admin/export-leaderboard', (req, res) => {
  const snapshot = buildLeaderboardSnapshot();

  if (!contestHasEnded()) {
    return res.status(200).json({
      warning: 'Contest is still running. Export is available after the contest end time.',
      leaderboard: snapshot,
    });
  }

  const problems = snapshot.globalProblems || [];
  const header = ['Rank', 'Contestant Name', 'Total Points', 'Fully Solved', 'Partially Solved', 'Total Time Spent', ...problems.map((problem) => problem.problemName)];
  const rows = snapshot.users.map((user, index) => {
    const problemStatuses = problems.map((problem) => {
      const entry = (user.problems || []).find((item) => item.problemName === problem.problemName);
      return entry ? (entry.lastRecordedStatus || entry.status) : 'Unsolved';
    });

    return [index + 1, user.username, user.totalPoints, user.solvedCount, user.partialCount, user.totalTimeSpent, ...problemStatuses];
  });

  const escapeCsvValue = (value) => {
    const text = String(value ?? '');
    const needsQuotes = /[",\n]/.test(text);
    return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const csv = [header, ...rows].map((row) => row.map(escapeCsvValue).join(',')).join('\n');

  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment('final_leaderboard.csv');
  return res.send(csv);
});

app.get('/api/admin/submissions', (req, res) => {
  const userSnapshots = Object.values(users).map((user) => serializeUser(user));

  return res.json({
    contestStart: CONTEST_START,
    contestEnd: CONTEST_END,
    contestActive: contestIsActive(),
    contestEnded: contestHasEnded(),
    globalProblems: DEFAULT_PROBLEMS.map((problem) => ({
      problemName: problem.problemName,
      url: problem.url,
      points: Number.isFinite(problem.points) ? problem.points : 0,
    })),
    users: userSnapshots,
  });
});

// Monitor the contest clock internally
const endContestMonitor = setInterval(() => {
    // Check if current time has passed the contest end time
    if (Date.now() >= CONTEST_END) {
        finalizeAllActiveSessions();
        
        // Stop checking once it's done
        clearInterval(endContestMonitor);
    }
}, 5000); // Checks every 5 seconds

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Contest dashboard API listening on http://localhost:${PORT}`);
});
