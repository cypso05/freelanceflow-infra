// navigation.js - Include in all HTML files
const navigation = `
<nav style="background: white; padding: 15px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); position: sticky; top: 0; z-index: 100;">
    <div style="max-width: 1200px; margin: 0 auto; padding: 0 20px; display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; gap: 30px; align-items: center;">
            <a href="/" style="font-weight: bold; color: #0078d4; text-decoration: none; font-size: 18px;"> FreelanceFlow</a>
            <a href="/forms" style="color: #333; text-decoration: none;">Forms</a>
            <a href="/contracts" style="color: #333; text-decoration: none;">Contracts</a>
            <a href="/invoices" style="color: #333; text-decoration: none;">Invoices</a>
            <a href="/receipts" style="color: #333; text-decoration: none;">Receipts</a>
        </div>
        <div>
            <span id="user-badge" style="background: #f0f0f0; padding: 5px 10px; border-radius: 5px;">Loading...</span>
        </div>
    </div>
</nav>
`;

document.addEventListener('DOMContentLoaded', () => {
    // Insert navigation at the beginning of body
    document.body.insertAdjacentHTML('afterbegin', navigation);
    
    // Load user info
    fetch('/api/user/profile')
        .then(res => res.json())
        .then(user => {
            document.getElementById('user-badge').innerHTML = ` ${user.email || 'Pro User'}`;
        });
});
