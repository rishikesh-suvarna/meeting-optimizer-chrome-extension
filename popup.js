// Check authentication status when popup is opened
document.addEventListener('DOMContentLoaded', () => {
  checkAuthStatus();

  // Set up event listeners
  document
    .getElementById('auth-button')
    .addEventListener('click', authenticate);
  document
    .getElementById('save-settings')
    .addEventListener('click', saveSettings);
  document
    .getElementById('refresh-meetings')
    .addEventListener('click', loadMeetings);
});

// Check if user is authenticated
function checkAuthStatus() {
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    if (token) {
      showAuthenticatedUI();
    } else {
      showUnauthenticatedUI();
    }
  });
}

// Show UI for authenticated users
function showAuthenticatedUI() {
  document.getElementById('auth-section').style.display = 'none';
  document.getElementById('settings-section').style.display = 'block';
  loadSettings();
  loadMeetings();
}

// Show UI for unauthenticated users
function showUnauthenticatedUI() {
  document.getElementById('auth-section').style.display = 'block';
  document.getElementById('settings-section').style.display = 'none';
}

// Authenticate with Google
function authenticate() {
  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    if (token) {
      showAuthenticatedUI();
    } else {
      alert('Authentication failed. Please try again.');
    }
  });
}

// Load saved settings
function loadSettings() {
  chrome.storage.sync.get(
    ['minutesBeforeMeeting', 'closeAfterMeeting'],
    (settings) => {
      if (settings.minutesBeforeMeeting) {
        document.getElementById('minutes-before').value =
          settings.minutesBeforeMeeting.toString();
      }

      if (settings.hasOwnProperty('closeAfterMeeting')) {
        document.getElementById('close-after').checked =
          settings.closeAfterMeeting;
      }
    }
  );
}

// Save settings
function saveSettings() {
  const minutesBeforeMeeting = parseInt(
    document.getElementById('minutes-before').value
  );
  const closeAfterMeeting = document.getElementById('close-after').checked;

  chrome.storage.sync.set(
    {
      minutesBeforeMeeting,
      closeAfterMeeting,
    },
    () => {
      // Trigger background script to refresh meeting schedule
      chrome.runtime.sendMessage({ action: 'refreshMeetings' });

      showSaveConfirmation();
    }
  );
}

// Show save confirmation
function showSaveConfirmation() {
  const saveButton = document.getElementById('save-settings');
  const originalText = saveButton.textContent;

  saveButton.textContent = 'Saved!';
  saveButton.disabled = true;

  setTimeout(() => {
    saveButton.textContent = originalText;
    saveButton.disabled = false;
  }, 1500);
}

// Load upcoming meetings
function loadMeetings() {
  const meetingsListElement = document.getElementById('meetings-list');
  meetingsListElement.innerHTML =
    '<p class="loading">Loading upcoming meetings...</p>';

  chrome.identity.getAuthToken({ interactive: false }, async (token) => {
    if (!token) {
      meetingsListElement.innerHTML = '<p class="error">Not authenticated</p>';
      return;
    }

    try {
      // Define time range for upcoming meetings
      const now = new Date();
      const timeMin = now.toISOString();

      // Set timeMax to end of today
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);
      const timeMax = endOfDay.toISOString();

      // Fetch events from Google Calendar
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Error fetching events: ${response.statusText}`);
      }

      const data = await response.json();
      const events = data.items || [];

      // Filter for meetings with video links
      const meetingsWithLinks = events.filter(
        (event) => extractMeetingLink(event) !== null
      );

      if (meetingsWithLinks.length === 0) {
        meetingsListElement.innerHTML =
          '<p class="empty-state">No meetings with video links found today</p>';
        return;
      }

      // Build HTML for meetings list
      const meetingsHtml = meetingsWithLinks
        .map((event) => {
          const link = extractMeetingLink(event);
          const startTime = new Date(event.start.dateTime || event.start.date);
          const formattedTime = startTime.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });

          return `
          <div class="meeting-item">
            <div class="meeting-title">${
              event.summary || 'Unnamed meeting'
            }</div>
            <div class="meeting-time">${formattedTime}</div>
            ${
              link
                ? `<a href="${link}" class="meeting-link" target="_blank">${link}</a>`
                : ''
            }
          </div>
        `;
        })
        .join('');

      meetingsListElement.innerHTML = meetingsHtml;
    } catch (error) {
      console.error('Error loading meetings:', error);
      meetingsListElement.innerHTML =
        '<p class="error">Error loading meetings. Please try again.</p>';
    }
  });
}

// Extract meeting link from event
function extractMeetingLink(event) {
  // Check for Google Meet link
  if (event.hangoutLink) {
    return event.hangoutLink;
  }

  // Check for conference data
  if (event.conferenceData?.entryPoints) {
    for (const entryPoint of event.conferenceData.entryPoints) {
      if (entryPoint.uri && entryPoint.type === 'video') {
        return entryPoint.uri;
      }
    }
  }

  // Check for Zoom, Teams, or other meeting links in description or location
  const textToSearch = [event.description || '', event.location || ''].join(
    ' '
  );

  // Regex for common meeting links
  const patterns = [
    /https:\/\/[^\/]*zoom.us\/[^\s]+/i, // Zoom
    /https:\/\/teams.microsoft.com\/l\/meetup-join\/[^\s]+/i, // Teams
    /https:\/\/meet.google.com\/[a-z-]+/i, // Google Meet
  ];

  for (const pattern of patterns) {
    const match = textToSearch.match(pattern);
    if (match) return match[0];
  }

  return null;
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'meetingsUpdated') {
    loadMeetings();
  }
});
