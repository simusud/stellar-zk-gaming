use dep::std;

fn main(
    move: u8, 
    salt: Field,
    commitment: pub Field
) {
    // move: 0 for Cooperate, 1 for Defect
    assert(move < 2);

    // commitment = Pedersen(move, salt)
    let hash = std::hash::pedersen_hash([move as Field, salt]);
    assert(hash == commitment);
}

#[test]
fn test_valid_commitment() {
    let move = 0;
    let salt = 123;
    let commitment = std::hash::pedersen_hash([move as Field, salt]);
    main(move, salt, commitment);
}
