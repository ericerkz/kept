const sidebar = document.querySelector('.sidebar');
const menuBtn = document.querySelector('.menu-btn');
const navItems = document.querySelectorAll('.nav-item');
const contentArea = document.querySelector('.content');

// Sidebar toggle
menuBtn.addEventListener('click', () => {
  if (sidebar.style.width === '0px') {
    sidebar.style.width = 'var(--sidebar-width)';
    sidebar.style.opacity = '1';
    setTimeout(() => { sidebar.style.display = 'flex'; }, 0);
  } else {
    sidebar.style.width = '0px';
    sidebar.style.opacity = '0';
    setTimeout(() => { sidebar.style.display = 'none'; }, 300);
  }
});

// Update active nav based on scroll position
const sections = Array.from(document.querySelectorAll('.note-card, h2[id]')).filter(el => el.id);

contentArea.addEventListener('scroll', () => {
  let current = '';
  const scrollY = contentArea.scrollTop;

  sections.forEach(section => {
    // Adding offset for comfortable highlighting
    const sectionTop = section.offsetTop - 150; 
    if (scrollY >= sectionTop) {
      current = section.getAttribute('id');
    }
  });

  if (!current && sections.length > 0) {
    current = sections[0].getAttribute('id');
  }

  navItems.forEach(item => {
    item.classList.remove('active');
    if (item.getAttribute('href') === `#${current}`) {
      item.classList.add('active');
    }
  });
});

// Auto-close sidebar on mobile when a link is clicked
if (window.innerWidth <= 768) {
  sidebar.style.width = '0px';
  sidebar.style.display = 'none';
  
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      sidebar.style.width = '0px';
      setTimeout(() => { sidebar.style.display = 'none'; }, 300);
    });
  });
}
