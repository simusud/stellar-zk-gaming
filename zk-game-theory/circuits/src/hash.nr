use dep::std;

fn main(
    move_val: Field, 
    salt: Field
) -> pub Field {
    std::hash::pedersen_hash([move_val, salt])
}
