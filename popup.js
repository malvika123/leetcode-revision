// ======================
// Constants
// ======================
const TIME_RANGES = {
    WEEK: 604800,
    MONTH: 2592000
};

// ======================
// Utility Functions
// ======================
function formatDate(timestamp) {
    return timestamp ? new Date(timestamp * 1000).toLocaleDateString() : 'never';
}

async function getCookie(name) {
    return new Promise(resolve => {
        chrome.cookies.get({
            url: 'https://leetcode.com',
            name: name
        }, cookie => resolve(cookie?.value));
    });
}

// ======================
// Login Status Functions
// ======================
async function verifyLogin() {
    try {
        const [LEETCODE_SESSION, csrfToken] = await Promise.all([
            getCookie('LEETCODE_SESSION'),
            getCookie('csrftoken')
        ]);
        return !!(LEETCODE_SESSION && csrfToken);
    } catch (error) {
        console.error('Login verification failed:', error);
        return false;
    }
}

function updateLoginStatus(isLoggedIn) {
    const loginStatusElement = document.getElementById('loginStatus');
    const analyzeButton = document.getElementById('analyzeBtn');

    if (!loginStatusElement) return;

    loginStatusElement.innerHTML = `
        <div class="login-status ${isLoggedIn ? 'logged-in' : 'logged-out'}">
            <span class="status-icon"></span>
            ${isLoggedIn ? 'Logged in to LeetCode' : 'Not logged in'}
        </div>
    `;

    if (analyzeButton) {
        analyzeButton.disabled = !isLoggedIn;
    }
}

// ======================
// Data Fetching
// ======================
async function fetchLeetCodeSubmissions(offset = 0, lastKey = '') {
    try {
        const [LEETCODE_SESSION, csrfToken] = await Promise.all([
            getCookie('LEETCODE_SESSION'),
            getCookie('csrftoken')
        ]);

        if (!LEETCODE_SESSION || !csrfToken) return null;

        const url = `https://leetcode.com/api/submissions/?offset=${offset}&limit=20&lastkey=${lastKey}`;
        const response = await fetch(url, {
            headers: {
                'X-CSRFToken': csrfToken,
                'Referer': 'https://leetcode.com/submissions/'
            },
            credentials: 'include'
        });

        return response.ok ? await response.json() : null;
    } catch (error) {
        return null;
    }
}

async function fetchQuestionDifficulties() {
    try {
        const response = await fetch('https://leetcode.com/api/problems/all/');
        const data = await response.json();

        const difficulties = {};
        data.stat_status_pairs.forEach(problem => {
            difficulties[problem.stat.question__title_slug] = {
                difficulty: problem.difficulty.level === 2 ? 'Medium' :
                    problem.difficulty.level === 1 ? 'Easy' : 'Hard'
            };
        });

        return difficulties;
    } catch (error) {
        console.error('Failed to fetch difficulties:', error);
        return {};
    }
}

// ======================
// Data Processing
// ======================
async function getAllSubmissions() {
    let allSubmissions = [];
    let lastKey = '';
    let attempt = 0;

    try {
        while (attempt < 10) {
            const data = await fetchLeetCodeSubmissions(attempt * 20, lastKey);
            if (!data?.submissions_dump) break;

            allSubmissions.push(...data.submissions_dump);
            lastKey = data.last_key;
            if (!data.has_next) break;

            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            attempt++;
        }
    } catch (error) {
        console.error('Partial submissions fetched:', allSubmissions.length);
    }
    console.log("all submission", allSubmissions);
    return allSubmissions;
}

function processSubmissions(submissions) {
    const questionMap = new Map();

    submissions.forEach(sub => {
        const slug = sub.title_slug;

        if (!questionMap.has(slug)) {
            questionMap.set(slug, {
                title: sub.title,
                slug: slug,
                totalAttempts: 0,
                failedAttempts: 0,
                lastSubmitted: sub.timestamp,
                submissions: [] // Store all submission attempts
            });
        }

        const question = questionMap.get(slug);
        question.totalAttempts++;
        question.submissions.push(sub); // Store the full submission

        if (sub.status_display !== 'Accepted') {
            question.failedAttempts++;
        }

        // Update last submission time if newer
        if (sub.timestamp > question.lastSubmitted) {
            question.lastSubmitted = sub.timestamp;
        }
    });
    console.log(questionMap);

    return Object.fromEntries(questionMap);
}

// ======================
// Recommendation Logic
// ======================
function getFailedMediumQuestions(stats, difficulties) {
    const oneWeekAgo = Date.now() / 1000 - TIME_RANGES.WEEK;

    const eligibleQuestions = Object.values(stats).filter(q =>
        difficulties[q.slug]?.difficulty === 'Medium' &&
        q.lastSubmitted < oneWeekAgo && Math.round((q.totalAttempts - q.failedAttempts) / q.totalAttempts * 100) < 60
    );

    // Fisher-Yates shuffle
    for (let i = eligibleQuestions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [eligibleQuestions[i], eligibleQuestions[j]] = [eligibleQuestions[j], eligibleQuestions[i]];
    }

    return eligibleQuestions.slice(0, 3);
}

function getLessPracticedQuestions(stats, difficulties) {
    const fiveDaysAgo = Date.now() / 1000 - (5 * 24 * 60 * 60);

    const eligibleQuestions = Object.values(stats).filter(q => {
        const diff = difficulties[q.slug]?.difficulty;
        return (diff === 'Medium' || diff === 'Hard') &&
            q.totalAttempts <= 7 &&
            q.lastSubmitted < fiveDaysAgo;
    });

    // Fisher-Yates shuffle
    for (let i = eligibleQuestions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [eligibleQuestions[i], eligibleQuestions[j]] = [eligibleQuestions[j], eligibleQuestions[i]];
    }

    return eligibleQuestions.slice(0, 3);
}

const LeetCodeCache = {
    CACHE_KEY: 'lc_revision_data',
    CACHE_DURATION: 30 * 60 * 1000, // 30 minutes

    // Get cached data (returns Promise)
    async get() {
        return new Promise(resolve => {
            chrome.storage.local.get([this.CACHE_KEY], result => {
                try {
                    if (!result[this.CACHE_KEY]) {
                        resolve(null);
                        return;
                    }

                    const { timestamp, data } = result[this.CACHE_KEY];
                    const isFresh = Date.now() - timestamp < this.CACHE_DURATION;
                    const isValid = data?.submissions && data?.difficulties;

                    resolve(isFresh && isValid ? data : null);
                } catch (e) {
                    this.clear();
                    resolve(null);
                }
            });
        });
    },

    // Store data (returns Promise)
    async set(data) {
        return new Promise(resolve => {
            chrome.storage.local.set({
                [this.CACHE_KEY]: {
                    timestamp: Date.now(),
                    data: {
                        submissions: data.submissions,
                        difficulties: data.difficulties
                    }
                }
            }, () => resolve());
        });
    },

    // Clear cache (returns Promise)
    async clear() {
        return new Promise(resolve => {
            chrome.storage.local.remove(this.CACHE_KEY, () => resolve());
        });
    }
};


async function fetchDataWithCache() {
    // 1. Try to get cached data first
    try{
    const cachedData = await LeetCodeCache.get();
    if (cachedData) {
        console.log('Using cached data', cachedData);
        return cachedData;
    }

    // 2. Fetch fresh data if no valid cache
    console.log('Fetching fresh data');
    const [submissions, difficulties] = await Promise.all([
        getAllSubmissions(),
        fetchQuestionDifficulties()
    ]);

    // 3. Cache the new data
    await LeetCodeCache.set({ submissions, difficulties });

    return { submissions, difficulties };
} catch (error) {
    console.error("Fetch error:", error);
    return { submissions: [], difficulties: {} }; // Return empty data to gracefully degrade
  }
}

function createQuestionCard(question, type) {
    const card = document.createElement('div');
    card.className = 'question-card';

    const metric = type === 'failed'
        ? `Success: ${Math.round((question.totalAttempts - question.failedAttempts) / question.totalAttempts * 100)}%`
        : `Attempts: ${question.totalAttempts}`;

    card.innerHTML = `
        <div class="metric ${type}">${metric}</div>
        <h4>${question.title}</h4>
        <div class="stats">
            <span>Last tried: ${formatDate(question.lastSubmitted)}</span>
        </div>
        <a href="https://leetcode.com/problems/${question.slug}" 
           target="_blank" 
           class="practice-btn">
            Practice Now
        </a>
    `;

    return card;
}

function displayRecommendations(results) {
    const container = document.getElementById('recommendations');
    const status = document.getElementById('status');

    container.innerHTML = '';
    let totalCount = 0;



    if (results.lessPracticed.length > 0) {
        container.innerHTML += '<h3 class="section-header">Less Practiced Problems</h3>';
        results.lessPracticed.forEach(q => {
            container.appendChild(createQuestionCard(q, 'less'));
        });
        totalCount += results.lessPracticed.length;
    }

    if (results.failedMedium.length > 0) {
        container.innerHTML += '<h3 class="section-header">Problems to Review</h3>';
        results.failedMedium.forEach(q => {
            container.appendChild(createQuestionCard(q, 'failed'));
        });
        totalCount += results.failedMedium.length;
    }

    if (totalCount === 0) {
        container.innerHTML = `
            <div class="no-recommendations">
                <p>All caught up! Consider trying new problems!</p>
            </div>
        `;
    }

    status.textContent = `Found ${totalCount} recommendations`;
}

// ======================
// Main Analysis Function
// ======================
async function analyzeSubmissions() {
    const analyzeBtn = document.getElementById('analyzeBtn');
    const status = document.getElementById('status');
    const recommendations = document.getElementById('recommendations');

    try {
        // Verify login status first
        const isLoggedIn = await verifyLogin();
        if (!isLoggedIn) {
            status.textContent = 'Please login to LeetCode first';
            updateLoginStatus(false);
            return;
        }

        analyzeBtn.disabled = true;
        status.textContent = 'Please wait, this can take a min...';

        // Get data (either cached or fresh)
        const { submissions, difficulties } = await fetchDataWithCache();


        status.textContent = 'Analyzing submissions...';
        recommendations.innerHTML = '';
        status.textContent = 'Analyzing submissions...';



        const stats = processSubmissions(submissions);
        const results = {
            failedMedium: getFailedMediumQuestions(stats, difficulties),
            lessPracticed: getLessPracticedQuestions(stats, difficulties)
        };

        displayRecommendations(results);

    } catch (error) {
        status.textContent = 'Error analyzing submissions. Please try again.';
        console.error('Analysis error:', error);
    } finally {
        analyzeBtn.disabled = false;
    }
}

// ======================
// Initialization
// ======================
async function initializeApp() {
    const isLoggedIn = await verifyLogin();
    updateLoginStatus(isLoggedIn);

    const analyzeBtn = document.getElementById('analyzeBtn');
    if (analyzeBtn) {
        analyzeBtn.addEventListener('click', analyzeSubmissions);
    }
}

document.addEventListener('DOMContentLoaded', initializeApp);

document.getElementById('clearCacheBtn')?.addEventListener('click', async () => {
    await LeetCodeCache.clear();
    alert('Cache cleared successfully!');
});
