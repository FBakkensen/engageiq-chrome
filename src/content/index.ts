/// <reference types="chrome"/>

console.log('EngageIQ content script loaded');

/**
 * Utility to detect and enhance LinkedIn comment fields
 */
class LinkedInIntegration {
  // Track processed comment fields
  private processedFields: Set<HTMLElement> = new Set();
  // Track comment UI elements
  private commentUIElements: Map<HTMLElement, HTMLElement> = new Map();
  // Store the current post content for comment generation
  private currentPostContent: EngageIQ.PostContent | null = null;
  // Track button states
  private isGenerating: boolean = false;

  /**
   * Initialize the integration
   */
  init() {
    console.log('LinkedIn integration initialized');
    
    // Listen for messages from extension
    this.setupMessageListener();
    
    // Set up observer to detect dynamically loaded content
    this.setupMutationObserver();
    
    // Initial scan for LinkedIn posts
    const postsDetected = this.scanForLinkedInPosts();
    console.log(`EngageIQ: Initial scan detected ${postsDetected} LinkedIn posts`);
    
    // Initial scan for existing comment fields
    this.scanForCommentFields();
  }
  
  /**
   * Listen for messages from the extension
   */
  setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      console.log('Content script received message:', message);
      
      if ('type' in message) {
        switch (message.type) {
          case 'COMMENT_GENERATED':
            this.handleCommentGenerated(message.payload);
            sendResponse({ success: true });
            break;
            
          case 'INSERT_COMMENT':
            this.insertComment(message.payload.comment, message.payload.elementId);
            sendResponse({ success: true });
            break;
            
          case 'GET_LINKEDIN_POST_STATUS':
            // Trigger a fresh scan
            const postsCount = this.scanForLinkedInPosts();
            // Get number of processed comment fields
            const commentFieldsCount = this.processedFields.size;
            
            sendResponse({ 
              success: true,
              postsDetected: postsCount,
              commentFieldsDetected: commentFieldsCount,
              url: window.location.href,
              isLinkedInPage: this.isLinkedInPage()
            });
            break;
          
          default:
            sendResponse({ error: 'Unknown message type' });
        }
      }
      
      return true; // Keep the message channel open for async response
    });
  }
  
  /**
   * Check if the current page is a LinkedIn page
   */
  isLinkedInPage(): boolean {
    const hostname = window.location.hostname;
    return hostname.includes('linkedin.com');
  }
  
  /**
   * Set up mutation observer to detect new elements
   */
  setupMutationObserver() {
    const observer = new MutationObserver(
      this.debounce((_mutations) => {
        // Scan for new posts
        this.scanForLinkedInPosts();
        
        // Scan for comment fields that might not be in detected posts
        this.scanForCommentFields();
      }, 500)
    );
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    // Also observe scroll events as LinkedIn loads content dynamically when scrolling
    window.addEventListener('scroll', this.debounce(() => {
      console.log('EngageIQ: Scroll event detected, scanning for new content');
      this.scanForLinkedInPosts();
    }, 1000));
    
    // Watch for LinkedIn's view changes that might trigger new content
    window.addEventListener('pushstate', this.debounce(() => {
      console.log('EngageIQ: Navigation detected (pushstate), scanning for new content');
      setTimeout(() => {
        this.scanForLinkedInPosts();
        this.scanForCommentFields();
      }, 1000); // Wait for the DOM to update
    }, 500));
    
    // Also listen for click events on LinkedIn's navigation items that don't trigger pushstate
    document.addEventListener('click', this.debounce((e) => {
      const target = e.target as HTMLElement;
      const navItem = target.closest('a[href^="/"], button[data-control-name]');
      
      if (navItem) {
        console.log('EngageIQ: Navigation action detected, scheduling scan');
        setTimeout(() => {
          this.scanForLinkedInPosts();
          this.scanForCommentFields();
        }, 1500); // Wait longer for navigation to complete
      }
    }, 500));
    
    console.log('Mutation observer and event listeners set up');
  }
  
  /**
   * Scan for LinkedIn comment fields
   * LinkedIn has several patterns for comment fields depending on the view
   */
  scanForCommentFields() {
    console.log('EngageIQ: Scanning for LinkedIn comment fields');
    
    // Feed comment fields (most common)
    const feedCommentSelectors = [
      // Main feed comment input field 
      '.comments-comment-box__form',
      // Comment input field with content editable - more specific
      '[contenteditable="true"][aria-label*="comment"]',
      '[contenteditable="true"][aria-label*="Add a comment"]',
      '[contenteditable="true"][aria-label*="Leave a comment"]',
      '[contenteditable="true"][aria-label*="Reply"]',
      // Alternative comment field structure
      '.comments-comment-texteditor__contenteditable',
      // Post update comment field
      '.update-components-text-editor__container [contenteditable="true"]',
      // Newer LinkedIn comment fields
      '.comments-comment-box [contenteditable="true"]',
      '.comments-comment-texteditor [contenteditable="true"]',
      // Comment form identifiers
      'form.comments-comment-box__form [contenteditable="true"]',
      // Language-agnostic selectors (works across LinkedIn locales)
      'div[role="textbox"][contenteditable="true"]',
      // Even broader matches for contenteditable areas in likely comment areas
      '.comments-comment-box textarea',
      '.artdeco-text-input--input'
    ];
    
    console.log('EngageIQ: Looking for comment fields with selectors:', feedCommentSelectors.join(', '));
    
    // Track newly found fields in this scan
    let newFieldsFound = 0;
    
    // Scan for all potential comment fields
    feedCommentSelectors.forEach(selector => {
      const commentFields = document.querySelectorAll(selector);
      console.log(`EngageIQ: Found ${commentFields.length} fields with selector "${selector}"`);
      
      commentFields.forEach((field, index) => {
        const htmlField = field as HTMLElement;
        
        // Skip if already processed
        if (this.processedFields.has(htmlField)) {
          return;
        }
        
        console.log(`EngageIQ: Processing new comment field ${index} with selector "${selector}":`, htmlField);
        console.log(`EngageIQ: Field classes: "${htmlField.className}"`);
        
        // Additional heuristic: Check if this is really a comment field by looking for comment-related keywords
        const isLikelyCommentField = 
          // Check element attributes
          (htmlField.getAttribute('aria-label')?.toLowerCase().includes('comment') ||
           htmlField.getAttribute('placeholder')?.toLowerCase().includes('comment') ||
           htmlField.getAttribute('aria-label')?.toLowerCase().includes('reply') ||
           // Check for role="textbox" which LinkedIn uses for comment inputs
           htmlField.getAttribute('role') === 'textbox' ||
           // Check parent elements for comment-related classes
           htmlField.closest('.comments-comment-box') ||
           htmlField.closest('.comments-comment-texteditor') ||
           htmlField.closest('[data-control-name*="comment"]') ||
           // Check if the field is part of a post's comment section
           this.isFieldInCommentSection(htmlField) ||
           // Check if inside a form that looks like a comment form
           htmlField.closest('form.comments-comment-box__form'));
           
        if (!isLikelyCommentField) {
          console.log(`EngageIQ: Field ${index} does not appear to be a comment field, skipping`);
          return;
        }
        
        this.setupCommentField(htmlField);
        this.processedFields.add(htmlField);
        newFieldsFound++;
      });
    });
    
    // If no new fields found with specific selectors, try a more aggressive approach
    if (newFieldsFound === 0) {
      console.log('EngageIQ: No new comment fields found with specific selectors, trying broader approach');
      
      // Try two approaches for finding comment sections
      
      // 1. Look through detected posts for comment fields
      const posts = document.querySelectorAll('[data-engageiq-post-id]');
      console.log(`EngageIQ: Searching for comment fields in ${posts.length} detected posts`);
      
      posts.forEach((post, postIndex) => {
        // Look for comment sections within the post
        const commentSections = post.querySelectorAll(
          '.comments-comments-list, .comments-container, [data-test-id*="comments-list"]'
        );
        
        if (commentSections.length > 0) {
          console.log(`EngageIQ: Found ${commentSections.length} comment sections in post ${postIndex}`);
          
          // For each comment section, look for comment input fields
          commentSections.forEach((section) => {
            const editableFields = section.querySelectorAll('[contenteditable="true"], textarea, div[role="textbox"]');
            editableFields.forEach(field => {
              const htmlField = field as HTMLElement;
              if (!this.processedFields.has(htmlField)) {
                console.log('EngageIQ: Processing comment field from post search:', htmlField);
                this.setupCommentField(htmlField);
                this.processedFields.add(htmlField);
                newFieldsFound++;
              }
            });
          });
        }
        
        // Also look for comment buttons that might reveal comment fields when clicked
        const commentButtons = post.querySelectorAll(
          '[data-control-name*="comment"], button[aria-label*="comment"], .comment-button'
        );
        
        console.log(`EngageIQ: Found ${commentButtons.length} comment buttons in post ${postIndex}`);
        
        // Set up observers for these buttons to detect when comment fields appear
        commentButtons.forEach(button => {
          // Only set up if not already processed
          if (!(button as HTMLElement).hasAttribute('data-engageiq-observed')) {
            (button as HTMLElement).setAttribute('data-engageiq-observed', 'true');
            
            // Add click listener to scan for fields after button click
            button.addEventListener('click', () => {
              console.log('EngageIQ: Comment button clicked, scanning for comment fields');
              // Wait for the comment field to appear
              setTimeout(() => this.scanForCommentFields(), 500);
            });
          }
        });
      });
      
      // 2. Standard approach - look for any comment sections across the page
      if (newFieldsFound === 0) {
        // Look for any contenteditable near comments sections
        const commentSections = document.querySelectorAll(
          '.comments-comments-list, .comments-container, [data-test-id*="comments-list"]'
        );
        console.log(`EngageIQ: Found ${commentSections.length} comment sections in page-wide search`);
        
        commentSections.forEach((section, index) => {
          const editableFields = section.querySelectorAll('[contenteditable="true"], textarea, div[role="textbox"]');
          console.log(`EngageIQ: Found ${editableFields.length} editable fields in comment section ${index}`);
          
          editableFields.forEach(field => {
            const htmlField = field as HTMLElement;
            if (!this.processedFields.has(htmlField)) {
              console.log('EngageIQ: Processing comment field from page-wide search:', htmlField);
              this.setupCommentField(htmlField);
              this.processedFields.add(htmlField);
              newFieldsFound++;
            }
          });
        });
      }
    }
    
    console.log(`EngageIQ: Found ${newFieldsFound} new comment fields, total processed: ${this.processedFields.size}`);
    return newFieldsFound;
  }
  
  /**
   * Check if a field is within a comment section
   */
  isFieldInCommentSection(field: HTMLElement): boolean {
    // Check if field is within a comment section by looking at ancestors
    const isInCommentSection = !!field.closest('.comments-comment-box, .comments-container, .comments-comments-list');
    
    // Check if field is part of a comment form
    const isInCommentForm = !!field.closest('form[data-control-name*="comment"]');
    
    // Check if field has a comment-related class in its hierarchy
    let currentEl: HTMLElement | null = field;
    let maxDepth = 5;
    let hasCommentClass = false;
    
    while (currentEl && maxDepth > 0) {
      if (currentEl.className.toLowerCase().includes('comment')) {
        hasCommentClass = true;
        break;
      }
      currentEl = currentEl.parentElement;
      maxDepth--;
    }
    
    return isInCommentSection || isInCommentForm || hasCommentClass;
  }
  
  /**
   * Set up a detected comment field
   */
  setupCommentField(field: HTMLElement) {
    console.log('EngageIQ: Setting up comment field', field);
    console.log('EngageIQ: Field tag name:', field.tagName);
    console.log('EngageIQ: Field type:', field.getAttribute('type'));
    console.log('EngageIQ: Field class:', field.className);
    console.log('EngageIQ: Field contentEditable:', field.contentEditable);
    console.log('EngageIQ: Field aria-label:', field.getAttribute('aria-label'));
    
    // Find the closest container for positioning the button
    const container = this.findCommentContainer(field);
    
    if (!container) {
      console.warn('EngageIQ: Could not find container for comment field');
      
      // Use parent as fallback container
      if (field.parentElement) {
        console.log('EngageIQ: Using parent element as fallback container');
        this.setupCommentFieldWithContainer(field, field.parentElement);
      } else {
        console.warn('EngageIQ: No parent element available, cannot set up comment field');
      }
      return;
    }
    
    // Set up the field with the found container
    this.setupCommentFieldWithContainer(field, container);
  }
  
  /**
   * Set up a comment field with a specific container
   */
  private setupCommentFieldWithContainer(field: HTMLElement, container: HTMLElement) {
    console.log('EngageIQ: Setting up comment field with container:', container);
    console.log('EngageIQ: Container class:', container.className);
    
    // Track when field is clicked/focused
    const onFieldActivation = () => {
      console.log('EngageIQ: Comment field activated (focus/click)');
      
      // Extract post content when field is focused
      try {
        this.currentPostContent = this.extractPostContent(field);
        console.log('EngageIQ: Post content extracted:', this.currentPostContent);
        
        // Show the generate button if we have post content
        if (this.currentPostContent) {
          // First remove any existing buttons for this field to prevent duplicates
          this.removeExistingButtons(field);
          // Then show the button
          this.showGenerateButton(field, container);
        } else {
          console.warn('EngageIQ: No post content extracted, not showing button');
        }
      } catch (error) {
        console.error('EngageIQ: Error extracting post content:', error);
      }
    };
    
    // Add event listeners for both focus and click (some LinkedIn implementations respond better to one vs the other)
    console.log('EngageIQ: Adding event listeners to comment field');
    field.addEventListener('focus', onFieldActivation);
    field.addEventListener('click', onFieldActivation);
    
    // Track blur (unfocus) events to hide button when field is not active
    field.addEventListener('blur', () => {
      // Small delay to allow for clicking the button
      setTimeout(() => {
        // Check if the focus is outside our UI
        if (!document.activeElement || !field.contains(document.activeElement)) {
          console.log('EngageIQ: Comment field lost focus, hiding button');
          this.removeExistingButtons(field);
        }
      }, 200);
    });
    
    // Also listen for parents being clicked in case the actual field is complex
    if (container !== field) {
      container.addEventListener('click', (e) => {
        // Only process if the target isn't our UI
        if (!(e.target as HTMLElement).closest('[data-engageiq-ui="true"]')) {
          console.log('EngageIQ: Container clicked, focusing field');
          field.focus();
        }
      });
    }
    
    // We don't want to show the button immediately - only when focused
    // Do NOT include this logic that was showing buttons prematurely:
    // if (document.activeElement === field) {
    //   onFieldActivation();
    // }
    
    console.log('EngageIQ: Comment field setup complete');
  }
  
  /**
   * Remove any existing buttons for a field to prevent duplicates
   */
  private removeExistingButtons(field: HTMLElement) {
    // Remove from our tracking if it exists
    if (this.commentUIElements.has(field)) {
      const existingUI = this.commentUIElements.get(field);
      if (existingUI && document.contains(existingUI)) {
        existingUI.remove();
      }
      this.commentUIElements.delete(field);
    }
    
    // Also look for any buttons with the same field ID (in case tracking is out of sync)
    const fieldId = field.id;
    if (fieldId) {
      const buttonsWithFieldId = document.querySelectorAll(`[data-field-id="${fieldId}"]`);
      buttonsWithFieldId.forEach(button => {
        const container = button.closest('.engageiq-button-container');
        if (container) {
          container.remove();
        }
      });
    }
  }
  
  /**
   * Find the comment container element for a given field
   */
  findCommentContainer(field: HTMLElement): HTMLElement | null {
    // Try various parent selectors based on LinkedIn's DOM structure
    const possibleContainers = [
      '.comments-comment-box',
      '.comments-comment-texteditor',
      '.update-components-text-editor'
    ];
    
    let container: HTMLElement | null = null;
    
    // Search up the DOM tree
    let currentElement: HTMLElement | null = field;
    while (currentElement && !container) {
      for (const selector of possibleContainers) {
        if (currentElement.matches(selector)) {
          container = currentElement;
          break;
        }
      }
      
      currentElement = currentElement.parentElement;
      
      // Limit search depth
      if (currentElement && currentElement.tagName === 'BODY') {
        break;
      }
    }
    
    // If no specific container found, use parent
    if (!container && field.parentElement) {
      container = field.parentElement;
    }
    
    return container;
  }
  
  /**
   * Show the generate comment button
   */
  showGenerateButton(field: HTMLElement, container: HTMLElement) {
    // Check if button already exists for this field
    if (this.commentUIElements.has(field)) {
      const existingUI = this.commentUIElements.get(field);
      if (existingUI && document.contains(existingUI)) {
        // Button already exists and is still in the DOM
        console.log('EngageIQ: Generate button already exists for this field');
        return;
      } else {
        // Button exists in our tracking but is not in DOM
        console.log('EngageIQ: Recreating generate button as previous one was removed');
        this.commentUIElements.delete(field);
      }
    }
    
    // Find the optimal position for the button based on container layout
    const buttonPosition = this.calculateButtonPosition(container, field);
    
    // Create button container
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'engageiq-button-container';
    buttonContainer.setAttribute('data-engageiq-ui', 'true');
    buttonContainer.style.cssText = `
      position: absolute;
      ${buttonPosition.position};
      z-index: 1000;
      display: flex;
      align-items: center;
    `;
    
    // Create button with more refined styling to match LinkedIn's UI
    const generateButton = document.createElement('button');
    generateButton.className = 'engageiq-generate-button';
    generateButton.setAttribute('data-field-id', this.generateFieldId(field));
    
    // Check if the user is in dark mode
    const isDarkMode = this.isInDarkMode();
    console.log(`EngageIQ: User is in ${isDarkMode ? 'dark' : 'light'} mode`);
    
    // The button style changes based on the position
    const isAboveField = buttonPosition.position.includes('top: -36px');
    
    // Set colors based on theme
    const buttonBg = isDarkMode ? '#0073b1' : '#0a66c2';
    const buttonHoverBg = isDarkMode ? '#005582' : '#004182';
    const buttonTextColor = 'white';
    const buttonShadow = isDarkMode ? '0 1px 3px rgba(0,0,0,0.3)' : '0 1px 3px rgba(0,0,0,0.12)';
    
    // Apply different styling based on position
    if (isAboveField) {
      // Pill-shaped button when positioned above the field
      generateButton.style.cssText = `
        background-color: ${buttonBg};
        color: ${buttonTextColor};
        border: none;
        border-radius: 16px;
        height: 28px;
        padding: 0 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: ${buttonShadow};
        transition: all 0.2s ease;
        margin: 0;
        font-size: 12px;
        font-weight: 600;
        opacity: 0.9;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      `;
      
      // Store colors for hover handling
      generateButton.dataset.normalBg = buttonBg;
      generateButton.dataset.hoverBg = buttonHoverBg;
      
      // Use text + icon for better clarity
      const iconUrl = chrome.runtime.getURL('icons/icon16.png');
      generateButton.innerHTML = `
        <img src="${iconUrl}" width="14" height="14" alt="" style="margin-right: 6px; object-fit: contain;" />
        <span>Generate Comment</span>
      `;
      
      // Add responsive breakpoint - show just icon on small screens
      const mediaQuery = window.matchMedia('(max-width: 768px)');
      const handleScreenChange = (e: MediaQueryListEvent | MediaQueryList) => {
        if (e.matches) {
          // Small screen - show icon only
          generateButton.innerHTML = `<img src="${iconUrl}" width="14" height="14" alt="Generate" style="object-fit: contain;" />`;
          generateButton.style.padding = '0 8px';
        } else {
          // Larger screen - show icon and text
          generateButton.innerHTML = `
            <img src="${iconUrl}" width="14" height="14" alt="" style="margin-right: 6px; object-fit: contain;" />
            <span>Generate Comment</span>
          `;
          generateButton.style.padding = '0 12px';
        }
      };
      
      // Initial check
      handleScreenChange(mediaQuery);
      
      // Listen for changes
      mediaQuery.addEventListener('change', handleScreenChange);
    } else {
      // Round button when positioned inline with field
      generateButton.style.cssText = `
        background-color: ${buttonBg};
        color: ${buttonTextColor};
        border: none;
        border-radius: 50%;
        width: 28px;
        height: 28px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: ${buttonShadow};
        transition: all 0.2s ease;
        margin: 0 4px;
        font-size: 12px;
        opacity: 0.9;
      `;
      
      // Store colors for hover handling
      generateButton.dataset.normalBg = buttonBg;
      generateButton.dataset.hoverBg = buttonHoverBg;
      
      // Just icon for circular button
      const iconUrl = chrome.runtime.getURL('icons/icon16.png');
      generateButton.innerHTML = `
        <img src="${iconUrl}" width="16" height="16" alt="EngageIQ" style="object-fit: contain;" />
      `;
    }
    
    // Only add tooltip for the circular button style (not needed for labeled button)
    if (!isAboveField) {
      // Create tooltip with theme-aware styling
      const tooltip = document.createElement('div');
      tooltip.className = 'engageiq-tooltip';
      
      // Adjust tooltip style based on theme
      const tooltipBg = isDarkMode ? 'rgba(0, 0, 0, 0.9)' : 'rgba(0, 0, 0, 0.75)';
      const tooltipShadow = isDarkMode ? '0 2px 6px rgba(0,0,0,0.3)' : '0 2px 4px rgba(0,0,0,0.1)';
      
      tooltip.style.cssText = `
        position: absolute;
        top: -30px;
        left: 50%;
        transform: translateX(-50%);
        background-color: ${tooltipBg};
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.2s;
        pointer-events: none;
        box-shadow: ${tooltipShadow};
      `;
      tooltip.textContent = 'Generate AI Comment';
      generateButton.appendChild(tooltip);
      
      // Show/hide tooltip on hover with improved animation
      generateButton.addEventListener('mouseover', () => {
        generateButton.style.transform = 'scale(1.1)';
        generateButton.style.backgroundColor = generateButton.dataset.hoverBg || buttonHoverBg;
        tooltip.style.opacity = '1';
      });
      
      generateButton.addEventListener('mouseout', () => {
        generateButton.style.transform = 'scale(1)';
        generateButton.style.backgroundColor = generateButton.dataset.normalBg || buttonBg;
        tooltip.style.opacity = '0';
      });
    } else {
      // For labeled button, just change color on hover (no tooltip needed)
      generateButton.addEventListener('mouseover', () => {
        generateButton.style.backgroundColor = generateButton.dataset.hoverBg || buttonHoverBg;
      });
      
      generateButton.addEventListener('mouseout', () => {
        generateButton.style.backgroundColor = generateButton.dataset.normalBg || buttonBg;
      });
    }
    
    // Add animation and active state for clicks
    generateButton.addEventListener('mousedown', () => {
      generateButton.style.transform = 'scale(0.95)';
      generateButton.style.boxShadow = 'none';
    });
    
    generateButton.addEventListener('mouseup', () => {
      generateButton.style.transform = isAboveField ? 'scale(1)' : 'scale(1.1)';
      generateButton.style.boxShadow = buttonShadow;
    });
    
    generateButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleGenerateClick(field);
    });
    
    // Add button to container
    buttonContainer.appendChild(generateButton);
    
    // Check if the container position is set to static
    const containerPosition = window.getComputedStyle(container).position;
    if (containerPosition === 'static') {
      container.style.position = 'relative';
    }
    
    // Add container to the comment field container
    container.appendChild(buttonContainer);
    
    // Add entrance animation 
    buttonContainer.animate(
      [
        { opacity: 0, transform: 'translateY(5px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ],
      { 
        duration: 200,
        easing: 'ease-out'
      }
    );
    
    // Store reference to the button container
    this.commentUIElements.set(field, buttonContainer);
    
    console.log('EngageIQ: Added generate button to comment field:', field);
  }
  
  /**
   * Calculate the best position for the button based on container layout
   */
  calculateButtonPosition(container: HTMLElement, _field: HTMLElement): { position: string } {
    // Get container dimensions
    const containerRect = container.getBoundingClientRect();
    
    // Start with a safer default position: above the comment field
    let position = 'top: -36px; right: 0;';
    
    console.log(`EngageIQ: Comment container dimensions: ${Math.round(containerRect.width)}x${Math.round(containerRect.height)}`);
    
    // Check for LinkedIn's emoji button which is usually in the comment form footer
    const emojiButtonSelectors = [
      'button.comments-comment-box__form-emoji-button', 
      'button.comments-comment-texteditor__emoji-button', 
      'button[aria-label*="emoji"]',
      '.ql-emoji'
    ];
    
    // Find all emoji button candidates
    const emojiButtons: HTMLElement[] = [];
    emojiButtonSelectors.forEach(selector => {
      const buttons = container.querySelectorAll(selector);
      buttons.forEach(btn => emojiButtons.push(btn as HTMLElement));
    });
    
    if (emojiButtons.length > 0) {
      console.log(`EngageIQ: Found ${emojiButtons.length} emoji button candidates`);
      
      // Get the leftmost emoji button (most likely to be in our way)
      const leftmostButton = emojiButtons.reduce((leftmost, current) => {
        const rect = current.getBoundingClientRect();
        const leftmostRect = leftmost ? leftmost.getBoundingClientRect() : { left: Infinity };
        return rect.left < leftmostRect.left ? current : leftmost;
      }, null as HTMLElement | null);
      
      if (leftmostButton) {
        const buttonRect = leftmostButton.getBoundingClientRect();
        console.log(`EngageIQ: Emoji button found at position: left=${Math.round(buttonRect.left)}, right=${Math.round(buttonRect.right)}`);
        
        // Calculate a position that avoids the emoji button
        // If there's enough space, position to the left of the emoji button
        if (buttonRect.left - containerRect.left > 40) {
          const rightOffset = containerRect.right - buttonRect.left + 8;
          position = `top: 50%; right: ${rightOffset}px; transform: translateY(-50%);`;
          console.log(`EngageIQ: Positioning to the left of emoji button: right=${rightOffset}px`);
        } else {
          // Not enough space to the left, position above the field
          position = 'top: -36px; right: 0;';
          console.log('EngageIQ: Not enough space left of emoji button, positioning above field');
        }
      }
    } else {
      console.log('EngageIQ: No emoji button found, using safer positioning');
    }
    
    // For narrow containers, always position above
    if (containerRect.width < 250) {
      position = 'top: -36px; right: 0;';
      console.log('EngageIQ: Narrow container, positioning above field');
    }
    
    // Always use above positioning as it's the most reliable
    console.log('EngageIQ: Using above-field positioning for maximum reliability');
    position = 'top: -36px; right: 0;';
    
    return { position };
  }
  
  /**
   * Generate a unique ID for the field
   */
  generateFieldId(field: HTMLElement): string {
    // Create unique ID if not already present
    if (!field.id) {
      field.id = `engageiq-field-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    }
    return field.id;
  }
  
  /**
   * Handle click on generate button
   */
  handleGenerateClick(field: HTMLElement) {
    // If already generating, return
    if (this.isGenerating) {
      console.log('EngageIQ: Already generating a comment, ignoring click');
      return;
    }
    
    // If no post content, try to extract it again
    if (!this.currentPostContent) {
      console.log('EngageIQ: No post content available, attempting to extract again');
      try {
        const postElement = this.findPostElementFromCommentField(field);
        if (postElement) {
          this.currentPostContent = this.extractPostContent(postElement);
        } else {
          console.warn('EngageIQ: Could not find parent post element');
        }
        
        if (!this.currentPostContent) {
          this.showErrorUI(field, "Couldn't determine what post you're commenting on. Please try again.");
          return;
        }
      } catch (error) {
        console.error('EngageIQ: Error extracting post content:', error);
        this.showErrorUI(field, "Couldn't access post content. Please try again.");
        return;
      }
    }
    
    // Set generating state
    this.isGenerating = true;
    
    // Vibrate device if supported (mobile feedback)
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
    
    // Update button UI to show loading state
    const fieldId = this.generateFieldId(field);
    const button = document.querySelector(`[data-field-id="${fieldId}"]`);
    
    // Provide visual feedback
    if (button) {
      // Check if the button is the labeled version or icon version
      const isLabeledButton = button.querySelector('span') !== null;
      
      if (isLabeledButton) {
        // Update labeled button 
        button.innerHTML = `
          <svg class="engageiq-spinner" width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" stroke="white" fill="none" stroke-width="3" stroke-dasharray="30 10" />
          </svg>
          <span style="margin-left: 6px;">Generating...</span>
        `;
      } else {
        // Update icon-only button
        button.innerHTML = `
          <svg class="engageiq-spinner" width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" stroke="white" fill="none" stroke-width="3" stroke-dasharray="30 10" />
          </svg>
        `;
      }
      
      // Add or update spinning animation if not already present
      if (!document.querySelector('#engageiq-spinner-style')) {
        const style = document.createElement('style');
        style.id = 'engageiq-spinner-style';
        style.innerHTML = `
          .engageiq-spinner {
            animation: engageiq-spin 1s linear infinite;
          }
          @keyframes engageiq-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `;
        document.head.appendChild(style);
      }
      
      // Update tooltip if it exists
      const tooltip = button.querySelector('.engageiq-tooltip');
      if (tooltip) {
        tooltip.textContent = 'Generating with Gemini...';
        (tooltip as HTMLElement).style.opacity = '1';
      }
      
      // Change button color to indicate busy state
      const isDarkMode = this.isInDarkMode();
      (button as HTMLElement).style.backgroundColor = isDarkMode ? '#006097' : '#0077b5';
    }
    
    console.log('EngageIQ: Sending comment generation request for post content:', this.currentPostContent);
    
    // Request comment generation from background script with comment options
    // In a future implementation, these options would be configurable by the user
    chrome.runtime.sendMessage({
      type: 'GENERATE_COMMENT',
      payload: {
        postContent: this.currentPostContent,
        options: {
          tone: 'professional', // Default tone
          length: 'medium' // Default length
        }
      }
    }, (response: EngageIQ.CommentGenerationResponse) => {
      this.isGenerating = false;
      
      if (chrome.runtime.lastError) {
        console.error('Chrome runtime error:', chrome.runtime.lastError);
        this.showErrorUI(field, "Connection error. Please try again.");
        return;
      }
      
      if (!response) {
        console.error('No response received from background script');
        this.showErrorUI(field, "No response from service. Please try again.");
        return;
      }
      
      if (!response.success || response.error) {
        console.error('Error generating comments:', response.error, response.errorDetails || '');
        
        // Determine the appropriate user-friendly error message based on error type
        let errorMessage = response.error || "Failed to generate comments";
        
        // Check for specific error types
        if (response.errorType === 'API_KEY') {
          errorMessage = "API key not configured. Please set up your Gemini API key in extension options.";
        } else if (response.errorType === 'NETWORK') {
          errorMessage = "Network error. Please check your internet connection and try again.";
        } else if (response.errorType === 'RATE_LIMIT') {
          errorMessage = "API rate limit exceeded. Please wait a moment and try again.";
        }
        
        this.showErrorUI(field, errorMessage);
        return;
      }
      
      if (response.success && response.comments) {
        console.log('EngageIQ: Successfully generated comments with Gemini API');
        // Vibrate to indicate success
        if (navigator.vibrate) {
          navigator.vibrate([50, 50, 50]);
        }
        this.showCommentsUI(field, response.comments);
      } else {
        console.error('Unknown response status:', response);
        this.showErrorUI(field, "Unexpected response. Please try again.");
      }
    });
    
    // Extend timeout for generation to 20 seconds due to real API calls
    setTimeout(() => {
      if (this.isGenerating) {
        console.log('EngageIQ: Generation timed out after 20 seconds');
        this.isGenerating = false;
        this.showErrorUI(field, "The Gemini API is taking longer than expected. Please try again later.");
      }
    }, 20000);
  }
  
  /**
   * Find parent post element from a comment field
   */
  findPostElementFromCommentField(field: HTMLElement): HTMLElement | null {
    // Search up through parent elements to find post container
    const postSelectors = [
      '.feed-shared-update-v2',
      '.update-components-update',
      'article.feed-shared-update',
      '.occludable-update',
      'article.ember-view',
      '[data-urn]',
      'div[data-id]'
    ];
    
    for (const selector of postSelectors) {
      const post = field.closest(selector);
      if (post) {
        return post as HTMLElement;
      }
    }
    
    // Fallback: look for post ID data attribute in parent elements
    const markedPost = field.closest('[data-engageiq-post-id]');
    if (markedPost) {
      return markedPost as HTMLElement;
    }
    
    console.warn('EngageIQ: Could not find parent post element for comment field');
    return null;
  }
  
  /**
   * Show error UI
   */
  showErrorUI(field: HTMLElement, errorMessage: string) {
    const fieldId = this.generateFieldId(field);
    const button = document.querySelector(`[data-field-id="${fieldId}"]`);
    if (button) {
      // Check if the button is the labeled version or icon version
      const isLabeledButton = button.querySelector('span') !== null;
      const isDarkMode = this.isInDarkMode();
      
      // Error colors based on theme
      const errorColor = '#e53935';
      const tooltipBgColor = isDarkMode ? '#2d2d2d' : '#fff';
      const tooltipTextColor = isDarkMode ? '#ff7a7a' : '#d93025';
      const tooltipBorderColor = isDarkMode ? '#444' : '#d0d0d0';
      
      if (isLabeledButton) {
        // Update labeled button with error state
        button.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 22C6.477 22 2 17.523 2 12C2 6.477 6.477 2 12 2C17.523 2 22 6.477 22 12C22 17.523 17.523 22 12 22ZM12 20C16.418 20 20 16.418 20 12C20 7.582 16.418 4 12 4C7.582 4 4 7.582 4 12C4 16.418 7.582 20 12 20ZM11 15H13V17H11V15ZM11 7H13V13H11V7Z" fill="white"/>
          </svg>
          <span style="margin-left: 6px;">Error</span>
        `;
      } else {
        // Update icon-only button
        button.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 22C6.477 22 2 17.523 2 12C2 6.477 6.477 2 12 2C17.523 2 22 6.477 22 12C22 17.523 17.523 22 12 22ZM12 20C16.418 20 20 16.418 20 12C20 7.582 16.418 4 12 4C7.582 4 4 7.582 4 12C4 16.418 7.582 20 12 20ZM11 15H13V17H11V15ZM11 7H13V13H11V7Z" fill="white"/>
          </svg>
        `;
      }
      
      // Change button background to indicate error
      (button as HTMLElement).style.backgroundColor = errorColor;
      
      // Create tooltip with error - enhanced with more LinkedIn-like styling
      const tooltip = document.createElement('div');
      tooltip.className = 'engageiq-error-tooltip';
      tooltip.style.cssText = `
        position: absolute;
        bottom: ${isLabeledButton ? '36px' : '40px'};
        right: 0;
        background-color: ${tooltipBgColor};
        border: 1px solid ${tooltipBorderColor};
        border-radius: 8px;
        padding: 12px 16px;
        font-size: 12px;
        color: ${tooltipTextColor};
        box-shadow: 0 4px 12px rgba(0,0,0,${isDarkMode ? '0.3' : '0.15'});
        max-width: 280px;
        z-index: 1001;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      `;
      
      // Format the error message
      tooltip.innerHTML = `
        <div style="display: flex; align-items: flex-start; margin-bottom: 8px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right: 8px; margin-top: 2px; flex-shrink: 0;">
            <path d="M12 22C6.477 22 2 17.523 2 12C2 6.477 6.477 2 12 2C17.523 2 22 6.477 22 12C22 17.523 17.523 22 12 22ZM11 15H13V17H11V15ZM11 7H13V13H11V7Z" fill="${tooltipTextColor}"/>
          </svg>
          <div style="flex: 1; font-weight: 500;">${errorMessage || 'Error generating comment'}</div>
        </div>
        <div style="margin-top: 8px; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 11px; opacity: 0.7;">Tap to try again</span>
          <button class="engageiq-error-close" style="background: none; border: none; cursor: pointer; color: ${isDarkMode ? '#999' : '#666'}; padding: 0; margin: 0; font-size: 12px;">Dismiss</button>
        </div>
      `;
      
      // Add to parent of button
      const buttonContainer = button.closest('.engageiq-button-container');
      if (buttonContainer) {
        buttonContainer.appendChild(tooltip);
        
        // Add click listener to close button
        const closeButton = tooltip.querySelector('.engageiq-error-close');
        if (closeButton) {
          closeButton.addEventListener('click', (e) => {
            e.stopPropagation();
            tooltip.remove();
            this.resetButton(button, isDarkMode);
          });
        }
        
        // Make the whole tooltip clickable to reset and try again
        tooltip.addEventListener('click', () => {
          tooltip.remove();
          this.resetButton(button, isDarkMode);
          
          // Try generation again after a short delay
          setTimeout(() => {
            if (field && document.contains(field)) {
              this.handleGenerateClick(field);
            }
          }, 100);
        });
        
        // Add entrance animation
        tooltip.animate(
          [
            { opacity: 0, transform: 'translateY(8px)' },
            { opacity: 1, transform: 'translateY(0)' }
          ],
          { 
            duration: 200,
            easing: 'ease-out'
          }
        );
        
        // Auto-remove after 8 seconds
        setTimeout(() => {
          // Check if tooltip still exists
          if (document.contains(tooltip)) {
            // Add exit animation
            const animation = tooltip.animate(
              [
                { opacity: 1, transform: 'translateY(0)' },
                { opacity: 0, transform: 'translateY(8px)' }
              ],
              { 
                duration: 200,
                easing: 'ease-in'
              }
            );
            
            animation.onfinish = () => {
              if (document.contains(tooltip)) {
                tooltip.remove();
              }
              this.resetButton(button, isDarkMode);
            };
          }
        }, 8000);
      }
    }
  }
  
  /**
   * Reset button to normal state
   */
  private resetButton(button: Element, isDarkMode: boolean) {
    // Restore button appearance
    const isLabeledButton = button.querySelector('span') !== null;
    const buttonBg = isDarkMode ? '#0073b1' : '#0a66c2';
    
    if (isLabeledButton) {
      // Reset labeled button
      const iconUrl = chrome.runtime.getURL('icons/icon16.png');
      button.innerHTML = `
        <img src="${iconUrl}" width="14" height="14" alt="" style="margin-right: 6px; object-fit: contain;" />
        <span>Generate Comment</span>
      `;
    } else {
      // Reset icon-only button
      const iconUrl = chrome.runtime.getURL('icons/icon16.png');
      button.innerHTML = `
        <img src="${iconUrl}" width="16" height="16" alt="EngageIQ" style="object-fit: contain;" />
      `;
    }
    
    // Reset style
    (button as HTMLElement).style.backgroundColor = buttonBg;
    (button as HTMLElement).style.transform = 'scale(1)';
  }
  
  /**
   * Show comments UI with generated options
   */
  showCommentsUI(field: HTMLElement, comments: EngageIQ.CommentResponse) {
    // Remove any existing comment UI
    const fieldId = this.generateFieldId(field);
    const existingUI = document.querySelector(`.engageiq-comments-ui[data-field-id="${fieldId}"]`);
    if (existingUI) {
      existingUI.remove();
    }
    
    // Reset generate button
    const button = document.querySelector(`[data-field-id="${fieldId}"]`);
    if (button) {
      const iconUrl = chrome.runtime.getURL('icons/icon16.png');
      button.innerHTML = `
        <img src="${iconUrl}" width="16" height="16" alt="EngageIQ" style="object-fit: contain;" />
      `;
      
      // Add back the tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'engageiq-tooltip';
      tooltip.style.cssText = `
        position: absolute;
        top: -30px;
        left: 50%;
        transform: translateX(-50%);
        background-color: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.2s;
        pointer-events: none;
      `;
      tooltip.textContent = 'Generate AI Comment';
      button.appendChild(tooltip);
    }
    
    // Create comments UI container
    const commentsUI = document.createElement('div');
    commentsUI.className = 'engageiq-comments-ui';
    commentsUI.setAttribute('data-field-id', fieldId);
    commentsUI.style.cssText = `
      position: absolute;
      bottom: 50px;
      right: 0;
      background-color: white;
      border-radius: 8px;
      border: 1px solid #e0e0e0;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      width: 350px;
      max-height: 400px;
      overflow-y: auto;
      z-index: 1001;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
    `;
    
    // Create header
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 12px 16px;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    `;
    
    const title = document.createElement('h3');
    title.style.cssText = `
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: #333;
    `;
    title.textContent = 'AI Comment Suggestions';
    
    const closeButton = document.createElement('button');
    closeButton.style.cssText = `
      background: none;
      border: none;
      cursor: pointer;
      color: #666;
      padding: 4px;
      font-size: 18px;
      line-height: 1;
    `;
    closeButton.innerHTML = '✕';
    closeButton.addEventListener('click', () => {
      commentsUI.remove();
    });
    
    header.appendChild(title);
    header.appendChild(closeButton);
    commentsUI.appendChild(header);
    
    // Create comment options
    const commentOptions = document.createElement('div');
    commentOptions.style.cssText = `
      padding: 12px 16px;
    `;
    
    // Map of tone to icon
    const toneIcons = {
      supportive: '👍',
      insightful: '💡',
      curious: '🤔',
      professional: '👔'
    };
    
    // Create a card for each comment type
    Object.entries(comments).forEach(([tone, comment]) => {
      const card = document.createElement('div');
      card.className = 'engageiq-comment-card';
      card.style.cssText = `
        background-color: #f9f9f9;
        border-radius: 8px;
        padding: 12px 16px;
        margin-bottom: 12px;
        cursor: pointer;
        transition: transform 0.2s, box-shadow 0.2s;
        border: 1px solid #e0e0e0;
      `;
      
      // Add hover effect
      card.addEventListener('mouseover', () => {
        card.style.backgroundColor = '#f0f7ff';
        card.style.transform = 'translateY(-2px)';
        card.style.boxShadow = '0 4px 8px rgba(0,0,0,0.05)';
      });
      
      card.addEventListener('mouseout', () => {
        card.style.backgroundColor = '#f9f9f9';
        card.style.transform = 'translateY(0)';
        card.style.boxShadow = 'none';
      });
      
      // Add click to insert
      card.addEventListener('click', () => {
        this.insertComment(comment, fieldId);
        commentsUI.remove();
      });
      
      // Create header with tone
      const cardHeader = document.createElement('div');
      cardHeader.style.cssText = `
        display: flex;
        align-items: center;
        margin-bottom: 8px;
      `;
      
      const icon = document.createElement('span');
      icon.style.cssText = `
        margin-right: 8px;
        font-size: 16px;
      `;
      icon.textContent = toneIcons[tone as keyof typeof toneIcons] || '💬';
      
      const toneLabel = document.createElement('span');
      toneLabel.style.cssText = `
        font-size: 12px;
        font-weight: 600;
        color: #0a66c2;
        text-transform: capitalize;
      `;
      toneLabel.textContent = tone.replace('_', ' ');
      
      cardHeader.appendChild(icon);
      cardHeader.appendChild(toneLabel);
      
      // Create comment text
      const commentText = document.createElement('p');
      commentText.style.cssText = `
        margin: 0;
        font-size: 13px;
        line-height: 1.4;
        color: #333;
      `;
      commentText.textContent = comment;
      
      // Create action button
      const useButton = document.createElement('button');
      useButton.style.cssText = `
        background-color: transparent;
        color: #0a66c2;
        border: none;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 12px;
        margin-top: 8px;
        cursor: pointer;
        font-weight: 600;
      `;
      useButton.textContent = 'Use this comment';
      useButton.addEventListener('mouseover', () => {
        useButton.style.backgroundColor = '#e8f0fe';
      });
      useButton.addEventListener('mouseout', () => {
        useButton.style.backgroundColor = 'transparent';
      });
      
      // Add elements to card
      card.appendChild(cardHeader);
      card.appendChild(commentText);
      card.appendChild(useButton);
      
      // Add card to options container
      commentOptions.appendChild(card);
    });
    
    commentsUI.appendChild(commentOptions);
    
    // Add footer with credits
    const footer = document.createElement('div');
    footer.style.cssText = `
      padding: 8px 16px;
      border-top: 1px solid #e0e0e0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: #666;
    `;
    
    const credits = document.createElement('span');
    credits.textContent = 'Powered by EngageIQ';
    
    const regenerateButton = document.createElement('button');
    regenerateButton.style.cssText = `
      background: none;
      border: none;
      color: #0a66c2;
      font-size: 11px;
      cursor: pointer;
      font-weight: 600;
    `;
    regenerateButton.textContent = 'Regenerate';
    regenerateButton.addEventListener('click', () => {
      commentsUI.remove();
      this.handleGenerateClick(field);
    });
    
    footer.appendChild(credits);
    footer.appendChild(regenerateButton);
    commentsUI.appendChild(footer);
    
    // Find where to add the UI
    const buttonContainer = button?.closest('.engageiq-button-container');
    if (buttonContainer?.parentElement) {
      buttonContainer.parentElement.appendChild(commentsUI);
    }
  }
  
  /**
   * Insert a comment into the field
   */
  insertComment(comment: string, fieldId?: string) {
    if (!fieldId) {
      console.warn('No field ID provided for comment insertion');
      return;
    }
    
    const field = document.getElementById(fieldId);
    if (!field) {
      console.warn(`Field with ID ${fieldId} not found`);
      return;
    }
    
    // Handle different types of input fields
    if (field.hasAttribute('contenteditable')) {
      // ContentEditable field (most LinkedIn comment fields)
      field.textContent = comment;
      
      // Trigger input event to notify LinkedIn
      const inputEvent = new Event('input', { bubbles: true });
      field.dispatchEvent(inputEvent);
    } else if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      // Text input field
      field.value = comment;
      
      // Trigger input event
      const inputEvent = new Event('input', { bubbles: true });
      field.dispatchEvent(inputEvent);
    }
    
    // Focus the field after insertion
    field.focus();
  }
  
  /**
   * Scan for LinkedIn posts 
   * This is separate from comment field detection to allow for highlighting posts
   */
  scanForLinkedInPosts() {
    console.log('EngageIQ: Scanning for LinkedIn posts');
    
    // Track detected posts
    const detectedPosts = new Set<HTMLElement>();
    
    // Different selectors for LinkedIn posts based on various feed layouts
    const postSelectors = [
      // Feed posts
      '.feed-shared-update-v2',
      '.update-components-update',
      'article.feed-shared-update',
      '.occludable-update', 
      // LinkedIn articles 
      '.scaffold-finite-scroll__content article',
      // Job posts
      '.job-view-layout',
      // Company pages posts
      '.org-updates__content article',
      // Profile activity posts
      '.profile-creator-shared-feed-update',
      // Newer post formats
      '[data-urn]',
      'div[data-id]',
      // Generic article elements (fallback)
      'article.ember-view'
    ];
    
    // Try each selector
    postSelectors.forEach(selector => {
      const posts = document.querySelectorAll(selector);
      console.log(`EngageIQ: Found ${posts.length} posts with selector "${selector}"`);
      
      posts.forEach(post => {
        const htmlPost = post as HTMLElement;
        
        // Skip already processed posts
        if (detectedPosts.has(htmlPost)) {
          return;
        }
        
        // Verify this is actually a post (not a header or sidebar element)
        if (this.isLikelyPost(htmlPost)) {
          console.log('EngageIQ: Detected LinkedIn post:', htmlPost);
          
          // Process the post
          this.processLinkedInPost(htmlPost);
          
          // Mark as processed
          detectedPosts.add(htmlPost);
        }
      });
    });
    
    console.log(`EngageIQ: Total posts detected: ${detectedPosts.size}`);
    return detectedPosts.size;
  }
  
  /**
   * Determine if an element is likely a LinkedIn post
   */
  isLikelyPost(element: HTMLElement): boolean {
    // Check element size (posts are usually substantial elements)
    const rect = element.getBoundingClientRect();
    if (rect.width < 300 || rect.height < 100) {
      return false;
    }
    
    // Check for common post components
    const hasAuthor = !!element.querySelector('.feed-shared-actor__name, .update-components-actor__name, a[href*="/in/"]');
    
    const hasContent = !!element.querySelector('.feed-shared-update-v2__description-wrapper, .feed-shared-text, p, .update-components-text');
    
    const hasEngagement = !!element.querySelector('.social-details-social-counts, .social-action-buttons, .comments-comment-box');
    
    // Check for "promoted" or "ad" content
    const isPromoted = !!element.querySelector('.feed-shared-actor__sub-description');
    const promotedText = isPromoted ? element.querySelector('.feed-shared-actor__sub-description')?.textContent?.toLowerCase() : '';
    const isAd = promotedText?.includes('promoted') || promotedText?.includes('ad') || false;
    
    // A post likely has author, content, and engagement elements
    const isLikelyPost = (hasAuthor && hasContent) || hasEngagement;
    
    console.log('EngageIQ: Post validation:', {
      size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      hasAuthor,
      hasContent,
      hasEngagement,
      isAd,
      isLikelyPost
    });
    
    return isLikelyPost && !isAd; // Exclude ads
  }
  
  /**
   * Process a detected LinkedIn post
   */
  processLinkedInPost(post: HTMLElement) {
    console.log('EngageIQ: Processing LinkedIn post:', post);
    
    // Extract post data
    const postContent = this.extractPostContent(post);
    
    // Store post data for later use
    if (postContent) {
      console.log('EngageIQ: Extracted post content:', postContent);
      // Store post data with unique ID
      const postId = this.generatePostId(post);
      post.setAttribute('data-engageiq-post-id', postId);
      
      // Add a subtle visual indicator for detected posts (only in development mode)
      if (location.hostname === 'localhost' || location.search.includes('engageiq-debug')) {
        this.addPostIndicator(post, postId);
      }
    }
    
    // Check for comment fields within this post
    const commentFields = post.querySelectorAll('.comments-comment-box__form [contenteditable="true"], [aria-label*="comment"]');
    console.log(`EngageIQ: Found ${commentFields.length} comment fields in this post`);
    
    commentFields.forEach(field => {
      if (!this.processedFields.has(field as HTMLElement)) {
        this.setupCommentField(field as HTMLElement);
        this.processedFields.add(field as HTMLElement);
      }
    });
  }
  
  /**
   * Add a visual indicator to show a post has been detected (for development/debugging)
   */
  addPostIndicator(post: HTMLElement, postId: string) {
    // Skip if already has indicator
    if (post.querySelector('.engageiq-post-indicator')) {
      return;
    }
    
    // Create indicator element
    const indicator = document.createElement('div');
    indicator.className = 'engageiq-post-indicator';
    indicator.setAttribute('data-engageiq-ui', 'true');
    indicator.style.cssText = `
      position: absolute;
      top: 0;
      right: 0;
      background-color: rgba(10, 102, 194, 0.1);
      border-left: 3px solid #0a66c2;
      padding: 4px 8px;
      font-size: 10px;
      color: #0a66c2;
      font-family: monospace;
      z-index: 1000;
      border-bottom-left-radius: 4px;
      opacity: 0.7;
      transition: opacity 0.2s, background-color 0.2s;
      pointer-events: none;
    `;
    indicator.textContent = `Post ID: ${postId.substring(0, 10)}...`;
    
    // Make sure post has relative positioning for absolute placement
    if (getComputedStyle(post).position === 'static') {
      post.style.position = 'relative';
    }
    
    // Add to post
    post.appendChild(indicator);
    
    // Fade out after 3 seconds
    setTimeout(() => {
      indicator.style.opacity = '0.3';
    }, 3000);
    
    // Add hover effect to parent
    post.addEventListener('mouseenter', () => {
      indicator.style.opacity = '0.9';
      indicator.style.backgroundColor = 'rgba(10, 102, 194, 0.2)';
    });
    
    post.addEventListener('mouseleave', () => {
      indicator.style.opacity = '0.3';
      indicator.style.backgroundColor = 'rgba(10, 102, 194, 0.1)';
    });
  }
  
  /**
   * Generate a unique ID for a post
   */
  generatePostId(post: HTMLElement): string {
    // Try to get LinkedIn's own post ID if available
    const urn = post.getAttribute('data-urn');
    if (urn) {
      return `urn-${urn}`;
    }
    
    const dataId = post.getAttribute('data-id');
    if (dataId) {
      return `id-${dataId}`;
    }
    
    // Fallback to generating our own ID
    return `post-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }
  
  /**
   * Extract post content for context
   * Enhanced version with better content extraction for various LinkedIn post types
   */
  extractPostContent(element: HTMLElement): EngageIQ.PostContent | null {
    // Determine if we're using a post element or a comment field
    const isCommentField = element.getAttribute('contenteditable') === 'true' || 
                         element.tagName === 'TEXTAREA' ||
                         element.getAttribute('aria-label')?.includes('comment');
    
    // Find the post container
    console.log('EngageIQ: Extracting post content from', isCommentField ? 'comment field' : 'post element');
    let postContainer = isCommentField ? this.findPostContainer(element) : element;
    
    if (!postContainer) {
      console.warn('EngageIQ: Could not find post container');
      
      // Log all parent elements to help debug
      if (isCommentField) {
        console.log('EngageIQ: Parent elements:');
        let parent = element.parentElement;
        let depth = 0;
        while (parent && depth < 5) {
          console.log(`EngageIQ: Parent level ${depth}:`, parent);
          console.log(`EngageIQ: Classes: "${parent.className}"`);
          parent = parent.parentElement;
          depth++;
        }
      }
      
      return {
        text: "Could not extract post content",
        author: "Unknown"
      };
    }
    
    console.log('EngageIQ: Found post container:', postContainer);
    console.log('EngageIQ: Post container classes:', postContainer.className);
    
    // Initialize post content
    const postContent: EngageIQ.PostContent = {
      text: '',
      author: 'LinkedIn User'
    };
    
    // STEP 1: Determine post type
    postContent.postType = this.determinePostType(postContainer);
    console.log(`EngageIQ: Detected post type: ${postContent.postType}`);
    
    // STEP 2: Extract post text content based on post type and container
    postContent.text = this.extractPostText(postContainer, postContent.postType);
    
    // STEP 3: Extract author information
    const authorInfo = this.extractAuthorInfo(postContainer);
    postContent.author = authorInfo.name;
    postContent.authorTitle = authorInfo.title;
    postContent.authorCompany = authorInfo.company;
    
    // STEP 4: Extract media content (images, videos, etc.)
    postContent.images = this.extractMediaContent(postContainer, postContent.postType);
    
    // STEP 5: Extract timestamp
    postContent.timestamp = this.extractTimestamp(postContainer);
    
    // STEP 6: Extract engagement metrics
    postContent.engagement = this.extractEngagementMetrics(postContainer);
    
    // STEP 7: Extract URL
    postContent.url = this.extractPostUrl(postContainer);
    
    // STEP 8: Extract hashtags and mentions
    const { hashtags, mentions } = this.extractHashtagsAndMentions(postContent.text);
    postContent.hashtags = hashtags.length > 0 ? hashtags : undefined;
    postContent.mentions = mentions.length > 0 ? mentions : undefined;
    
    console.log('EngageIQ: Extracted post content:', postContent);
    
    return postContent;
  }
  
  /**
   * Determine the type of LinkedIn post
   */
  private determinePostType(postContainer: HTMLElement): EngageIQ.PostContent['postType'] {
    // Check for image post
    const hasImages = !!postContainer.querySelector('.feed-shared-image, .update-components-image img');
    
    // Check for article post
    const hasArticle = !!postContainer.querySelector('.feed-shared-article, .article-card, [data-test-id*="article"]');
    
    // Check for video post
    const hasVideo = !!postContainer.querySelector('video, .feed-shared-video, [data-test-id*="video"]');
    
    // Check for document post
    const hasDocument = !!postContainer.querySelector('.feed-shared-document, [data-test-id*="document"]');
    
    // Check for poll post
    const hasPoll = !!postContainer.querySelector('.feed-shared-poll, [data-test-id*="poll"]');
    
    // Check for job post
    const hasJob = !!postContainer.querySelector('.job-card, .job-view-layout, [data-test-id*="job"]');
    
    // Check for event post
    const hasEvent = !!postContainer.querySelector('.event-card, [data-test-id*="event"]');
    
    // Check for shared post
    const isShared = !!postContainer.querySelector('.feed-shared-reshared-update, [data-test-id*="reshare"]');
    
    // Determine the post type based on the checks
    if (hasVideo) return 'video';
    if (hasArticle) return 'article';
    if (hasDocument) return 'document';
    if (hasPoll) return 'poll';
    if (hasJob) return 'job';
    if (hasEvent) return 'event';
    if (isShared) return 'share';
    if (hasImages) return 'image';
    
    // Default to text post
    return 'text';
  }
  
  /**
   * Extract post text based on post type and container
   */
  private extractPostText(postContainer: HTMLElement, postType: EngageIQ.PostContent['postType']): string {
    let postText = '';
    
    // LinkedIn has different selectors for text content based on post type
    const selectors = [
      // Common selectors
      '.feed-shared-update-v2__description-wrapper',
      '.feed-shared-text',
      '.update-components-text',
      
      // Post type specific selectors
      ...(postType === 'article' ? ['.feed-shared-article__description', '.article-card__description'] : []),
      ...(postType === 'image' ? ['.feed-shared-image__description'] : []),
      ...(postType === 'video' ? ['.feed-shared-video__description'] : []),
      ...(postType === 'document' ? ['.feed-shared-document__description'] : []),
      ...(postType === 'poll' ? ['.feed-shared-poll__question'] : []),
      ...(postType === 'job' ? ['.job-card__description', '.job-view-layout__description'] : []),
      ...(postType === 'event' ? ['.event-card__description'] : []),
      ...(postType === 'share' ? ['.feed-shared-reshared-update__description'] : [])
    ];
    
    // Try all selectors
    for (const selector of selectors) {
      const elements = postContainer.querySelectorAll(selector);
      elements.forEach(element => {
        const text = element.textContent?.trim();
        if (text) {
          postText += text + ' ';
        }
      });
    }
    
    // If no text found with specific selectors, try more general approach
    if (!postText) {
      console.log('EngageIQ: No post text found with primary selectors, trying alternative selectors');
      
      // First try basic paragraph and div elements with direction attributes (common in LinkedIn)
      const basicTextElements = postContainer.querySelectorAll('p, div[dir="ltr"], div[dir="rtl"], div.update-components-text');
      basicTextElements.forEach(element => {
        // Skip certain elements that are not likely to be main content
        if (element.closest('.comments-comment-item') || 
            element.closest('form') ||
            element.getAttribute('data-engageiq-ui') === 'true') {
          return;
        }
        
        const text = element.textContent?.trim();
        if (text) {
          postText += text + ' ';
        }
      });
      
      // If still no text, try to get any text content from the post avoiding UI elements
      if (!postText) {
        // Get all text nodes, excluding certain UI elements
        const textNodes = this.getTextNodes(postContainer);
        textNodes.forEach(node => {
          const text = node.textContent?.trim();
          if (text && text.length > 10) { // Only include substantial text
            postText += text + ' ';
          }
        });
      }
    }
    
    // Clean up text - remove excess whitespace
    postText = postText.trim().replace(/\s+/g, ' ');
    
    return postText || 'LinkedIn post';
  }
  
  /**
   * Get all text nodes within an element, excluding scripts and style elements
   */
  private getTextNodes(node: Node): Text[] {
    const textNodes: Text[] = [];
    
    // Skip certain elements that are likely not main content
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (element.tagName === 'SCRIPT' || 
          element.tagName === 'STYLE' || 
          element.getAttribute('data-engageiq-ui') === 'true' ||
          element.classList.contains('comments-comment-item') ||
          element.classList.contains('comments-comment-box')) {
        return textNodes;
      }
    }
    
    // Add text nodes
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text && text.length > 0) {
        textNodes.push(node as Text);
      }
    }
    
    // Process child nodes
    const childNodes = node.childNodes;
    for (let i = 0; i < childNodes.length; i++) {
      textNodes.push(...this.getTextNodes(childNodes[i]));
    }
    
    return textNodes;
  }
  
  /**
   * Extract author information from post container
   */
  private extractAuthorInfo(postContainer: HTMLElement): { name: string; title?: string; company?: string } {
    // Default values
    const authorInfo: { name: string; title?: string; company?: string } = {
      name: 'LinkedIn User'
    };
    
    // Try to find author name using various selectors
    const authorSelectors = [
      '.feed-shared-actor__name', 
      '.update-components-actor__name',
      '.actor-name',
      '.article-author-name',
      '.profile-card-one-to-one__profile-link'
    ];
    
    for (const selector of authorSelectors) {
      const elements = postContainer.querySelectorAll(selector);
      if (elements.length > 0) {
        const name = elements[0].textContent?.trim();
        if (name) {
          authorInfo.name = name;
          break;
        }
      }
    }
    
    // If still no author, try links with profile URLs
    if (authorInfo.name === 'LinkedIn User') {
      const profileLinks = postContainer.querySelectorAll('a[href*="/in/"]');
      if (profileLinks.length > 0) {
        const name = profileLinks[0].textContent?.trim();
        if (name) {
          authorInfo.name = name;
        }
      }
    }
    
    // Try to extract author title and company
    const titleSelectors = [
      '.feed-shared-actor__description', 
      '.update-components-actor__description',
      '.actor-subtitle'
    ];
    
    for (const selector of titleSelectors) {
      const elements = postContainer.querySelectorAll(selector);
      if (elements.length > 0) {
        const fullTitle = elements[0].textContent?.trim();
        if (fullTitle) {
          // LinkedIn often uses format "Title at Company"
          const titleParts = fullTitle.split(' at ');
          if (titleParts.length >= 2) {
            authorInfo.title = titleParts[0].trim();
            authorInfo.company = titleParts[1].trim();
          } else {
            authorInfo.title = fullTitle;
          }
          break;
        }
      }
    }
    
    return authorInfo;
  }
  
  /**
   * Extract media content (images, videos) from post
   */
  private extractMediaContent(postContainer: HTMLElement, postType?: EngageIQ.PostContent['postType']): string[] | undefined {
    const mediaUrls: string[] = [];
    
    // Extract images
    const imageSelectors = [
      'img.feed-shared-image',
      '.update-components-image img',
      '.feed-shared-article__preview-image',
      '.feed-shared-update__image',
      '.feed-shared-mini-article-list-item__image',
      '.article-card__image'
    ];
    
    for (const selector of imageSelectors) {
      const images = postContainer.querySelectorAll(selector);
      images.forEach(img => {
        const src = (img as HTMLImageElement).src;
        if (src && !src.includes('data:image') && !mediaUrls.includes(src)) {
          mediaUrls.push(src);
        }
      });
    }
    
    // Extract poster images from videos
    if (postType === 'video') {
      const videoElements = postContainer.querySelectorAll('video');
      videoElements.forEach(video => {
        // Try to get poster image
        const poster = video.getAttribute('poster');
        if (poster && !mediaUrls.includes(poster)) {
          mediaUrls.push(poster);
        }
        
        // Try to get thumbnail
        const thumbnail = video.getAttribute('data-thumbnail');
        if (thumbnail && !mediaUrls.includes(thumbnail)) {
          mediaUrls.push(thumbnail);
        }
      });
    }
    
    return mediaUrls.length > 0 ? mediaUrls : undefined;
  }
  
  /**
   * Extract timestamp from post
   */
  private extractTimestamp(postContainer: HTMLElement): string | undefined {
    // Try to find timestamp
    const timeSelectors = [
      '.feed-shared-actor__sub-description time',
      '.update-components-actor__sub-description time',
      'time.feed-shared-time-ago',
      'time.update-components-time-ago',
      'time[datetime]'
    ];
    
    for (const selector of timeSelectors) {
      const timeElements = postContainer.querySelectorAll(selector);
      if (timeElements.length > 0) {
        // First try to get the datetime attribute
        const datetime = timeElements[0].getAttribute('datetime');
        if (datetime) {
          return datetime;
        }
        
        // Fall back to text content
        const timeText = timeElements[0].textContent?.trim();
        if (timeText) {
          return timeText;
        }
      }
    }
    
    // If no timestamp found, try looking for the time text directly
    const relativeTimeTextElements = postContainer.querySelectorAll('.feed-shared-actor__sub-description, .update-components-actor__sub-description');
    for (const element of relativeTimeTextElements) {
      const text = element.textContent?.trim();
      if (text && /(\d+[smhd]|\d+ (second|minute|hour|day|week|month|year)s?)/.test(text)) {
        return text;
      }
    }
    
    return undefined;
  }
  
  /**
   * Extract engagement metrics (likes, comments, shares)
   */
  private extractEngagementMetrics(postContainer: HTMLElement): EngageIQ.PostEngagement | undefined {
    const engagement: EngageIQ.PostEngagement = {};
    
    // Get social counts container
    const socialCountsSelectors = [
      '.social-details-social-counts',
      '.update-components-social-activity',
      '.social-action-counts'
    ];
    
    let socialCountsContainer: HTMLElement | null = null;
    
    for (const selector of socialCountsSelectors) {
      const elements = postContainer.querySelectorAll(selector);
      if (elements.length > 0) {
        socialCountsContainer = elements[0] as HTMLElement;
        break;
      }
    }
    
    if (!socialCountsContainer) {
      return undefined;
    }
    
    // Extract like count
    const likeElements = socialCountsContainer.querySelectorAll('[data-control-name="likes_count"], [data-control-name="like_count"], [aria-label*="like"], [aria-label*="reaction"]');
    if (likeElements.length > 0) {
      const likeText = likeElements[0].textContent?.trim();
      if (likeText) {
        // Extract numbers from text
        const likeMatch = likeText.match(/(\d+)/);
        if (likeMatch) {
          engagement.likes = parseInt(likeMatch[1], 10);
        }
      }
    }
    
    // Extract comment count
    const commentElements = socialCountsContainer.querySelectorAll('[data-control-name="comments_count"], [aria-label*="comment"]');
    if (commentElements.length > 0) {
      const commentText = commentElements[0].textContent?.trim();
      if (commentText) {
        // Extract numbers from text
        const commentMatch = commentText.match(/(\d+)/);
        if (commentMatch) {
          engagement.comments = parseInt(commentMatch[1], 10);
        }
      }
    }
    
    // Extract share count
    const shareElements = socialCountsContainer.querySelectorAll('[data-control-name="shares_count"], [aria-label*="share"]');
    if (shareElements.length > 0) {
      const shareText = shareElements[0].textContent?.trim();
      if (shareText) {
        // Extract numbers from text
        const shareMatch = shareText.match(/(\d+)/);
        if (shareMatch) {
          engagement.shares = parseInt(shareMatch[1], 10);
        }
      }
    }
    
    // Only return engagement if we found any metrics
    return Object.keys(engagement).length > 0 ? engagement : undefined;
  }
  
  /**
   * Extract post URL
   */
  private extractPostUrl(postContainer: HTMLElement): string | undefined {
    // Try to find a share link
    const shareSelectors = [
      'a[data-control-name="copy_linkedin"]',
      'button[aria-label*="share"]',
      '.feed-shared-control-menu__trigger'
    ];
    
    for (const selector of shareSelectors) {
      const elements = postContainer.querySelectorAll(selector);
      if (elements.length > 0) {
        // Check for post ID in data attributes
        const element = elements[0] as HTMLElement;
        const dataId = 
          element.getAttribute('data-urn') || 
          element.getAttribute('data-id') || 
          element.getAttribute('data-activity-urn');
        
        if (dataId) {
          // Could construct LinkedIn post URL, but it's complex
          return window.location.href;
        }
      }
    }
    
    // Find any post permalink
    const permalinkSelectors = [
      'a.feed-shared-permalink',
      'a[data-control-name="permalink"]'
    ];
    
    for (const selector of permalinkSelectors) {
      const elements = postContainer.querySelectorAll(selector);
      if (elements.length > 0) {
        const href = (elements[0] as HTMLAnchorElement).href;
        if (href) {
          return href;
        }
      }
    }
    
    // Finally, check the post container itself for an ID
    const postId = 
      postContainer.getAttribute('data-urn') || 
      postContainer.getAttribute('data-id') || 
      postContainer.getAttribute('data-activity-urn');
    
    if (postId) {
      return window.location.href;
    }
    
    return undefined;
  }
  
  /**
   * Extract hashtags and mentions from post text
   */
  private extractHashtagsAndMentions(text: string): { hashtags: string[]; mentions: string[] } {
    const hashtags: string[] = [];
    const mentions: string[] = [];
    
    // Find hashtags (format: #hashtag)
    const hashtagRegex = /#([a-zA-Z0-9_]+)/g;
    let hashtagMatch;
    while ((hashtagMatch = hashtagRegex.exec(text)) !== null) {
      const hashtag = hashtagMatch[1];
      if (!hashtags.includes(hashtag)) {
        hashtags.push(hashtag);
      }
    }
    
    // Find mentions (format: @mention)
    const mentionRegex = /@([a-zA-Z0-9_]+)/g;
    let mentionMatch;
    while ((mentionMatch = mentionRegex.exec(text)) !== null) {
      const mention = mentionMatch[1];
      if (!mentions.includes(mention)) {
        mentions.push(mention);
      }
    }
    
    return { hashtags, mentions };
  }
  
  /**
   * Find the post container for a comment field
   */
  findPostContainer(commentField: HTMLElement): HTMLElement | null {
    console.log('EngageIQ: Finding post container for comment field');
    
    // Try various parent selectors based on LinkedIn's DOM structure
    const possibleContainers = [
      '.feed-shared-update-v2',
      '.update-components-update',
      '.feed-shared-update',
      '.comments-comment-item', // For replies on comments
      '.occludable-update', // Feed items
      '.scaffold-finite-scroll__content', // Newer LinkedIn feed structure
      '.ember-view.occludable-update'
    ];
    
    console.log('EngageIQ: Checking for container selectors:', possibleContainers.join(', '));
    
    // Search up the DOM tree
    let currentElement: HTMLElement | null = commentField;
    const maxLevels = 10; // Prevent searching too far up
    let level = 0;
    
    while (currentElement && level < maxLevels) {
      // Log the element we're checking
      console.log(`EngageIQ: Checking level ${level}:`, currentElement);
      console.log(`EngageIQ: Classes: "${currentElement.className}"`);
      
      // Check if current element matches any of our selectors
      for (const selector of possibleContainers) {
        if (currentElement.matches(selector)) {
          console.log(`EngageIQ: Found matching container with selector: ${selector}`, currentElement);
          return currentElement;
        }
      }
      
      // Check if any direct ancestor matches
      for (const selector of possibleContainers) {
        const matchingAncestor = currentElement.closest(selector);
        if (matchingAncestor) {
          console.log(`EngageIQ: Found matching ancestor with selector: ${selector}`, matchingAncestor);
          return matchingAncestor as HTMLElement;
        }
      }
      
      // Move up the tree
      currentElement = currentElement.parentElement;
      level++;
    }
    
    // Try a more aggressive approach with broader selectors
    console.log('EngageIQ: No container found with primary selectors, trying broader search');
    
    const broaderSelectors = [
      'article',
      '.feed-shared-update',
      '.update-components-update',
      '.occludable-update',
      'div[data-urn]',
      'div[data-id]'
    ];
    
    let rootElement = commentField;
    // Get a higher-level parent to start broader search
    for (let i = 0; i < 3 && rootElement.parentElement; i++) {
      rootElement = rootElement.parentElement;
    }
    
    // Try the broader selectors
    for (const selector of broaderSelectors) {
      const elements = document.querySelectorAll(selector);
      console.log(`EngageIQ: Found ${elements.length} elements with selector: ${selector}`);
      
      // Find the closest container by proximity in the DOM
      for (const element of elements) {
        if (element.contains(commentField)) {
          console.log(`EngageIQ: Found containing element with broader selector: ${selector}`, element);
          return element as HTMLElement;
        }
      }
    }
    
    console.log('EngageIQ: No post container found');
    return null;
  }
  
  /**
   * Handle comment generation response
   */
  handleCommentGenerated(comments: EngageIQ.CommentResponse) {
    console.log('Received generated comments:', comments);
  }
  
  /**
   * Detect if user is in dark mode
   */
  isInDarkMode(): boolean {
    // Check if LinkedIn is in dark mode
    
    // Method 1: Check for LinkedIn's dark mode class
    const hasLinkedInDarkClass = document.documentElement.classList.contains('theme--dark');
    
    // Method 2: Check computed background color of the body
    const bodyBgColor = window.getComputedStyle(document.body).backgroundColor;
    // Dark backgrounds typically have low RGB values
    const isDarkBackground = this.isColorDark(bodyBgColor);
    
    // Method 3: Check media query
    const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    // Method 4: Check if any main containers have dark background
    const mainElement = document.querySelector('main');
    let mainHasDarkBg = false;
    
    if (mainElement) {
      const mainBgColor = window.getComputedStyle(mainElement).backgroundColor;
      mainHasDarkBg = this.isColorDark(mainBgColor);
    }
    
    // Log dark mode detection results for debugging
    console.log('EngageIQ: Dark mode detection:', {
      hasLinkedInDarkClass,
      isDarkBackground,
      prefersDarkScheme,
      mainHasDarkBg
    });
    
    // Give precedence to LinkedIn's specific indicators
    if (hasLinkedInDarkClass) return true;
    if (mainHasDarkBg) return true;
    
    // Fallback to general indicators
    return isDarkBackground || prefersDarkScheme;
  }
  
  /**
   * Helper to check if a color is dark based on its RGB values
   */
  isColorDark(color: string): boolean {
    // Extract RGB values using regex
    const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1], 10);
      const g = parseInt(rgbMatch[2], 10);
      const b = parseInt(rgbMatch[3], 10);
      
      // Calculate brightness (simplified formula)
      // Dark colors have low brightness values
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      
      return brightness < 128; // Threshold for dark colors
    }
    
    return false; // Default to light if color format is unknown
  }
  
  /**
   * Utility function to debounce frequent events
   */
  debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
  ): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    
    return function executedFunction(...args: Parameters<T>) {
      const later = () => {
        timeout = null;
        func(...args);
      };
      
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(later, wait);
    };
  }
}

// Initialize the LinkedIn integration when DOM is fully loaded
window.addEventListener('load', () => {
  const integration = new LinkedInIntegration();
  integration.init();
});