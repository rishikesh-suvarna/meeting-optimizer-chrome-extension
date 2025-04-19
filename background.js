// Configuration defaults
const DEFAULT_MINUTES_BEFORE_MEETING = 5;
const DEFAULT_CLOSE_AFTER_MEETING = true;
const CHECK_INTERVAL = 15; // minutes

// Initialize
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Meeting Optimizer installed');

  // Setup default settings
  chrome.storage.sync.set({
    minutesBeforeMeeting: DEFAULT_MINUTES_BEFORE_MEETING,
    closeAfterMeeting: DEFAULT_CLOSE_AFTER_MEETING,
  });

  // Create alarm to periodically check for meetings
  chrome.alarms.create('checkUpcomingMeetings', {
    periodInMinutes: CHECK_INTERVAL,
  });

  // Check for meetings immediately
  checkForUpcomingMeetings();
});

// Listen for alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkUpcomingMeetings') {
    checkForUpcomingMeetings();
  } else if (alarm.name.startsWith('openMeeting_')) {
    const meetingId = alarm.name.split('openMeeting_')[1];
    openMeetingTab(meetingId);
  } else if (alarm.name.startsWith('closeMeeting_')) {
    const tabId = parseInt(alarm.name.split('closeMeeting_')[1]);
    closeMeetingTab(tabId);
  }
});

// Function to get auth token
async function getAuthToken() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        resolve(null);
        return;
      }
      resolve(token);
    });
  });
}

// Check for upcoming meetings
async function checkForUpcomingMeetings() {
  try {
    const token = await getAuthToken();
    if (!token) {
      console.log('Not authenticated');
      return;
    }

    // Clear existing meeting alarms
    const existingAlarms = await chrome.alarms.getAll();
    for (const alarm of existingAlarms) {
      if (alarm.name.startsWith('openMeeting_')) {
        await chrome.alarms.clear(alarm.name);
      }
    }

    const events = await fetchUpcomingEvents(token);
    await processEvents(events);

    // Notify popup that meetings have been updated
    chrome.runtime.sendMessage({ action: 'meetingsUpdated' });
  } catch (error) {
    console.error('Error checking upcoming meetings:', error);
  }
}

// Fetch events from Google Calendar
async function fetchUpcomingEvents(token) {
  const now = new Date();
  const timeMin = now.toISOString();

  // Set timeMax to 24 hours from now
  const tomorrow = new Date(now);
  tomorrow.setHours(tomorrow.getHours() + 24);
  const timeMax = tomorrow.toISOString();

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true`,
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
  return data.items || [];
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

// Process events and set up alarms
async function processEvents(events) {
  const settings = await chrome.storage.sync.get([
    'minutesBeforeMeeting',
    'closeAfterMeeting',
  ]);
  const minutesBefore =
    settings.minutesBeforeMeeting || DEFAULT_MINUTES_BEFORE_MEETING;

  const now = new Date();
  const meetingsToStore = {};

  for (const event of events) {
    const meetingLink = extractMeetingLink(event);
    if (!meetingLink) continue;

    // Get meeting start and end times
    const startTime = new Date(event.start.dateTime || event.start.date);
    const endTime = new Date(event.end.dateTime || event.end.date);

    // Calculate when to open the tab
    const openTime = new Date(startTime);
    openTime.setMinutes(openTime.getMinutes() - minutesBefore);

    // If the opening time is in the future, schedule it
    if (openTime > now) {
      const delayInMinutes = (openTime.getTime() - now.getTime()) / (1000 * 60);
      const meetingData = {
        id: event.id,
        title: event.summary || 'Unnamed meeting',
        link: meetingLink,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      };

      // Store meeting data
      meetingsToStore[event.id] = meetingData;

      // Schedule opening the meeting tab
      await chrome.alarms.create(`openMeeting_${event.id}`, { delayInMinutes });

      console.log(
        `Scheduled "${event.summary}" to open in ${delayInMinutes.toFixed(
          1
        )} minutes`
      );
    }
  }

  // Store meeting data for reference when alarms fire
  await chrome.storage.local.set({ meetings: meetingsToStore });
}

// Open meeting tab
async function openMeetingTab(meetingId) {
  const data = await chrome.storage.local.get('meetings');
  const meetings = data.meetings || {};
  const meetingData = meetings[meetingId];

  if (!meetingData) {
    console.error(`Meeting data not found for id: ${meetingId}`);
    return;
  }

  // Open the tab
  const tab = await chrome.tabs.create({
    url: meetingData.link,
    active: false,
  });
  console.log(`Opened tab for "${meetingData.title}"`);

  // Schedule tab closing if enabled
  const settings = await chrome.storage.sync.get(['closeAfterMeeting']);
  if (settings.closeAfterMeeting) {
    const endTime = new Date(meetingData.endTime);
    const now = new Date();

    if (endTime > now) {
      const delayInMinutes = (endTime.getTime() - now.getTime()) / (1000 * 60);
      await chrome.alarms.create(`closeMeeting_${tab.id}`, { delayInMinutes });
      console.log(`Tab will close in ${delayInMinutes.toFixed(1)} minutes`);
    }
  }
}

// Close meeting tab
async function closeMeetingTab(tabId) {
  try {
    await chrome.tabs.get(tabId); // Check if tab exists
    await chrome.tabs.remove(tabId);
    console.log(`Closed meeting tab ${tabId}`);
  } catch (error) {
    console.error(`Error closing tab ${tabId}:`, error);
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'refreshMeetings') {
    checkForUpcomingMeetings();
    sendResponse({ success: true });
  }
  return true;
});
